import { invalidateCrmDailyForecastCache } from "@/lib/dashboard/invalidation";
// Runtime-safe: closing-area-merges pulls only TYPES from monthly-distributor-import (erased at
// build time), so this does not close the monthly-distributor-import -> monthly-targets value cycle.
import { foldAreaCodeForLine, foldAreaOptionsForLine } from "@/lib/sales/closing-area-merges";
import {
  loadProductMasterRows,
  loadProductPeriodPrices,
  loadProductPriceMapForPeriod,
} from "@/lib/sales/product-period-price";
import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";
import { memoInFlight, type SingleFlightEntry } from "@/lib/crm/ttl-single-flight";

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE OF TRUTH — sales targets live in `au.monthly_targets`, and nowhere else.
//
// `public.sales_targets` and `public.sales_target_batches` were DROPPED on 2026-09-06
// (supabase/migrations/20260906001400_drop_the_empty_legacy_sales_target_tables.sql). They held
// zero rows for their entire life and nothing ever read them. Recorded here because the trap they
// created outlived them: they were dangerous precisely BECAUSE they were empty rather than
// missing — they held the obvious name in the obvious schema and answered a SELECT with a
// confident, authoritative, wrong zero. A system tour on 2026-09-05 queried `public.sales_targets`
// for the current quarter and briefly had evidence that no sales targets existed at all.
//
// So if you find a reference to either name anywhere, it is stale by definition: the answer is
// always `au.monthly_targets`, read through the service-role RPCs below. Do not recreate them.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — Targets on the 42-area seat model. Grain: one target per
// (month, line, area, product). Targets ride the AREA/seat (not the person), so a
// new hire inherits them and a vacant area still carries its target; "Other" areas
// carry none. Input is map-or-reject: line/area/product must resolve to the
// canonical model or the row is rejected — targets are never auto-created for an
// unknown area or product. Achievement = SoS actuals ÷ targets (see the DB
// function au.f_monthly_achievement), rolled up rep → DM → region → line.
//
// au is not PostgREST-exposed, so all IO goes through the service-role-only public
// RPCs (phx_upsert_monthly_targets / phx_monthly_targets / phx_monthly_achievement).
// ─────────────────────────────────────────────────────────────────────────────

const PERIOD_RE = /^\d{4}-\d{2}$/;

/** Canonical sales line codes (fixed per owner: CNS, Pedia, Anti-infective). */
const LINE_ALIASES: Record<string, string> = {
  cns: "cns",
  pedia: "pedia",
  ["anti infective"]: "anti_infective",
  ["anti-infective"]: "anti_infective",
  ["anti_infective"]: "anti_infective",
  ["anti inf"]: "anti_infective",
  ["antiinfective"]: "anti_infective",
};

/**
 * Confidential products (LA003 Lacto Basic 1, LA004 Lacto Basic 2, SS001 Satoslim) are
 * CEO/Super-Admin-only (see src/lib/sales/access-scope.ts). They are excluded from the
 * attribution engine and every drill-down function, so they must never be accepted as a
 * target input either — otherwise a target row would surface the product name in the
 * SFE-Manager-visible achievement grid (au.f_monthly_achievement unions target keys).
 */
const CONFIDENTIAL_PRODUCT_CODES = new Set(["LA003", "LA004", "SS001"]);

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function optNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Stable lookup key: lower-cased, trimmed, whitespace-collapsed, punctuation stripped. */
function normKey(value: unknown): string {
  return str(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidPeriod(period: string | null | undefined): period is string {
  return typeof period === "string" && PERIOD_RE.test(period);
}

/**
 * Official Source-of-Sales line label ("Anti Infective", "CNS", "Pedia") -> canonical target
 * line_code. Exported so the Closing Matrix can look up the targets for the line it is showing
 * without re-deriving the alias table; LINE_ALIASES stays the single definition.
 *
 * Returns null for anything unrecognised — notably "Head Office", which is a confidential line
 * that carries no field target and must never silently resolve to one.
 */
export function resolveTargetLineCode(officialLine: string | null | undefined): string | null {
  return LINE_ALIASES[normKey(officialLine)] ?? null;
}

/** How much of the year one template download covers. */
export type TargetPeriodScope = "month" | "quarter" | "semester";

/**
 * The months a template covers, given the month on screen.
 *
 * CALENDAR quarters and halves (Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec; Jan-Jun, Jul-Dec), not three
 * or six months counted forward from the one selected. Targets here are set a quarter at a time
 * and paid semesterly, so "this quarter" means the company's quarter — a rolling window would hand
 * back a span that matches no plan and no payout, and the mistake would be invisible in the
 * download because the sheet would still look right.
 *
 * An unparseable period yields just itself: the caller's validation owns rejecting it, and a
 * template that silently expands a bad month into six bad months is worse than one that does not.
 */
export function expandTargetPeriodScope(period: string, scope: TargetPeriodScope): string[] {
  if (!isValidPeriod(period)) return [period];
  const [yearRaw, monthRaw] = period.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw); // 1-12
  if (!Number.isFinite(year) || !Number.isFinite(month)) return [period];

  const first =
    scope === "quarter"
      ? Math.floor((month - 1) / 3) * 3 + 1
      : scope === "semester"
        ? (month <= 6 ? 1 : 7)
        : month;
  const span = scope === "quarter" ? 3 : scope === "semester" ? 6 : 1;

  const out: string[] = [];
  for (let i = 0; i < span; i += 1) {
    out.push(`${year}-${String(first + i).padStart(2, "0")}`);
  }
  return out;
}

// ── Validation reference data ─────────────────────────────────────────────────

export type TargetValidationRefs = {
  /** normKey(line label or code) -> canonical line_code */
  lineByKey: Map<string, string>;
  /** normKey(area code or name) -> canonical area_code */
  areaByKey: Map<string, string>;
  /** `${line_code}|${area_code}` -> carries_target (true = targetable, false = "Other") */
  lineAreaCarriesTarget: Map<string, boolean>;
  /** normKey(product code or name) -> canonical product_code (upper) */
  productByKey: Map<string, string>;
  /** normKey(code or name) of confidential products — rejected as target input, never resolvable */
  confidentialByKey: Set<string>;
};

/** Load the canonical model + product reference used to validate target input. */
export async function loadTargetValidationRefs(): Promise<TargetValidationRefs> {
  const supabase = getSupabaseAdmin();

  const lineByKey = new Map<string, string>(Object.entries(LINE_ALIASES));
  const areaByKey = new Map<string, string>();
  const lineAreaCarriesTarget = new Map<string, boolean>();
  const productByKey = new Map<string, string>();
  const confidentialByKey = new Set<string>();

  const [mapResult, productRows] = await Promise.all([
    supabase.from("au_v_line_area_map").select("line_code,area_code,area_name,carries_target"),
    loadProductMasterRows(),
  ]);

  if (mapResult.error) throw mapResult.error;

  for (const row of mapResult.data ?? []) {
    const record = row as Record<string, unknown>;
    const lineCode = str(record.line_code).trim();
    const areaCode = str(record.area_code).trim();
    if (lineCode) lineByKey.set(normKey(lineCode), lineCode);
    if (areaCode) {
      areaByKey.set(normKey(areaCode), areaCode);
      const areaName = str(record.area_name).trim();
      if (areaName && !areaByKey.has(normKey(areaName))) areaByKey.set(normKey(areaName), areaCode);
      lineAreaCarriesTarget.set(`${lineCode}|${areaCode}`, record.carries_target === true);
    }
  }

  for (const record of productRows) {
    if (record.active === false) continue;
    const code = str(record.product_code).trim().toUpperCase();
    if (!code) continue;
    const name = str(record.product_name).trim();
    if (CONFIDENTIAL_PRODUCT_CODES.has(code)) {
      // Never resolvable to a target; record its keys so validation rejects it with a clear message.
      confidentialByKey.add(normKey(code));
      if (name) confidentialByKey.add(normKey(name));
      continue;
    }
    productByKey.set(normKey(code), code);
    if (name && !productByKey.has(normKey(name))) productByKey.set(normKey(name), code);
  }

  return { lineByKey, areaByKey, lineAreaCarriesTarget, productByKey, confidentialByKey };
}

// ── Input validation (map-or-reject) ──────────────────────────────────────────

export type TargetInputRow = {
  rowNumber: number;
  period: string;
  line: string;
  area: string;
  product: string;
  targetUnits: number | null;
  targetValue: number | null;
};

export type TargetIssue = {
  rowNumber: number;
  field: "period" | "line" | "area" | "product" | "target";
  code: string;
  message: string;
};

export type ResolvedTargetRow = {
  period: string;
  line_code: string;
  area_code: string;
  product_code: string;
  target_units: number | null;
  target_value: number | null;
};

export type TargetValidationResult = {
  valid: ResolvedTargetRow[];
  errors: TargetIssue[];
};

/**
 * Validate raw target rows against the canonical model. Every row must resolve to
 * a real (line, area, product); the (line, area) must be target-bearing ("Other"
 * areas are rejected); at least one of units/value must be a non-negative number.
 * Unresolved rows are rejected (never auto-created).
 */
export function validateTargetRows(
  rows: TargetInputRow[],
  refs: TargetValidationRefs,
): TargetValidationResult {
  const valid: ResolvedTargetRow[] = [];
  const errors: TargetIssue[] = [];
  /** (period, line, FOLDED area, product) already claimed, and by which row — see the fold below. */
  const seenCells = new Map<string, { rowNumber: number; areaCode: string }>();

  for (const row of rows) {
    const rowNumber = row.rowNumber;

    if (!isValidPeriod(row.period)) {
      errors.push({ rowNumber, field: "period", code: "invalid_period", message: `Invalid period "${row.period}" (expected YYYY-MM).` });
      continue;
    }

    const lineCode = refs.lineByKey.get(normKey(row.line));
    if (!lineCode) {
      errors.push({ rowNumber, field: "line", code: "unknown_line", message: `Unknown line "${row.line}".` });
      continue;
    }

    const areaCode = refs.areaByKey.get(normKey(row.area));
    if (!areaCode) {
      errors.push({ rowNumber, field: "area", code: "unknown_area", message: `Area "${row.area}" is not one of the 42 canonical areas.` });
      continue;
    }

    const carries = refs.lineAreaCarriesTarget.get(`${lineCode}|${areaCode}`);
    if (carries === undefined) {
      errors.push({ rowNumber, field: "area", code: "area_not_in_line", message: `Area "${areaCode}" is not mapped in line "${lineCode}".` });
      continue;
    }
    if (carries === false) {
      errors.push({ rowNumber, field: "area", code: "area_not_targetable", message: `Area "${areaCode}" is an "Other" area in "${lineCode}" and carries no target.` });
      continue;
    }

    if (refs.confidentialByKey.has(normKey(row.product))) {
      errors.push({ rowNumber, field: "product", code: "confidential_product", message: `Product "${row.product}" is confidential and cannot carry a field target.` });
      continue;
    }

    const productCode = refs.productByKey.get(normKey(row.product));
    if (!productCode) {
      errors.push({ rowNumber, field: "product", code: "unknown_product", message: `Unknown product "${row.product}".` });
      continue;
    }

    const targetUnits = row.targetUnits;
    const targetValue = row.targetValue;
    if (targetUnits == null && targetValue == null) {
      errors.push({ rowNumber, field: "target", code: "missing_target", message: "A target value or target units is required." });
      continue;
    }
    if ((targetUnits != null && targetUnits < 0) || (targetValue != null && targetValue < 0)) {
      errors.push({ rowNumber, field: "target", code: "negative_target", message: "Target cannot be negative." });
      continue;
    }

    // Store the merged pair's target on the surviving code. A sheet naming "Beni Suef" for Pedia is
    // ACCEPTED and folded onto GZ6 rather than rejected — under the owner's ruling it is the same
    // area, so the row means what the author intended. Validation above deliberately ran on the
    // ORIGINAL code, so a genuinely unmapped or "Other" area still reports itself by name.
    const targetAreaCode = foldAreaCodeForLine(lineCode, areaCode, row.period);

    // Folding makes a collision reachable that the sheet does not look like it has: Fayoum on one
    // row and Beni Suef on another now resolve to ONE cell. `phx_upsert_monthly_targets` is
    // ON CONFLICT DO UPDATE, so both would be sent and the LAST would silently win — the same
    // last-write-wins loss this pair already caused in the grid. Reject the later row and say which
    // one it collides with; never guess whether the author meant to replace or to sum.
    const cellKey = `${row.period}|${lineCode}|${targetAreaCode}|${productCode}`;
    const clash = seenCells.get(cellKey);
    if (clash) {
      const folded = targetAreaCode !== areaCode || clash.areaCode !== targetAreaCode;
      errors.push({
        rowNumber,
        field: "area",
        code: "duplicate_target_cell",
        message:
          `Row ${clash.rowNumber} already sets a ${row.period} target for ${productCode} in `
          + `"${targetAreaCode}"`
          + (folded
            ? ` — on "${lineCode}" areas "${clash.areaCode}" and "${areaCode}" are ONE area, so both rows are the same cell.`
            : ".")
          + " Combine them into a single row.",
      });
      continue;
    }
    seenCells.set(cellKey, { rowNumber, areaCode });

    valid.push({
      period: row.period,
      line_code: lineCode,
      area_code: targetAreaCode,
      product_code: productCode,
      target_units: targetUnits,
      target_value: targetValue,
    });
  }

  return { valid, errors };
}

/**
 * Validate then upsert target rows. Returns the number upserted and any rejected
 * rows. Nothing is written when there are zero valid rows.
 */
export async function upsertMonthlyTargets(input: {
  rows: TargetInputRow[];
  actorHrId?: string | null;
  source?: string;
}): Promise<{ upserted: number; errors: TargetIssue[] }> {
  const refs = await loadTargetValidationRefs();
  const { valid, errors } = validateTargetRows(input.rows, refs);
  if (valid.length === 0) return { upserted: 0, errors };

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_upsert_monthly_targets", {
    p_rows: valid,
    p_actor: input.actorHrId ?? null,
    p_source: input.source ?? "upload",
  });
  if (error) throw error;
  // The reps' daily forecast reads each month's target from the closing engine (cache audit, 2026-10-26).
  invalidateCrmDailyForecastCache("monthly targets saved");
  return { upserted: num(data), errors };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export type MonthlyTargetRow = {
  period: string;
  lineCode: string;
  areaCode: string;
  productCode: string;
  targetUnits: number | null;
  targetValue: number | null;
};

export async function loadMonthlyTargets(period: string): Promise<MonthlyTargetRow[]> {
  if (!isValidPeriod(period)) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_monthly_targets", { p_period: period });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    period: str(row.period),
    lineCode: str(row.line_code),
    areaCode: str(row.area_code),
    productCode: str(row.product_code),
    targetUnits: optNum(row.target_units),
    targetValue: optNum(row.target_value),
  }));
}

export type AchievementRow = {
  period: string;
  lineCode: string | null;
  regionCode: string | null;
  areaCode: string | null;
  areaState: string | null;
  isOther: boolean;
  repSeatId: string | null;
  repHrId: string | null;
  dmSeatId: string | null;
  dmHrId: string | null;
  productCode: string;
  actualUnits: number;
  actualValue: number;
  targetUnits: number | null;
  targetValue: number | null;
  achievementValue: number | null;
  achievementUnits: number | null;
  hasTarget: boolean;
  hasActual: boolean;
};

export async function loadMonthlyAchievement(period: string): Promise<AchievementRow[]> {
  if (!isValidPeriod(period)) return [];
  const supabase = getSupabaseAdmin();
  const rows = await rpcAll<Record<string, unknown>>(
    supabase,
    "phx_monthly_achievement",
    { p_period: period },
    ["line_code", "region_code", "area_code", "product_code"],
  );
  return rows.map((row) => ({
    period: str(row.period),
    lineCode: str(row.line_code) || null,
    regionCode: str(row.region_code) || null,
    areaCode: str(row.area_code) || null,
    areaState: str(row.area_state) || null,
    isOther: row.is_other === true,
    repSeatId: str(row.rep_seat_id) || null,
    repHrId: str(row.rep_hr_id) || null,
    dmSeatId: str(row.dm_seat_id) || null,
    dmHrId: str(row.dm_hr_id) || null,
    productCode: str(row.product_code),
    actualUnits: num(row.actual_units),
    actualValue: num(row.actual_value),
    targetUnits: optNum(row.target_units),
    targetValue: optNum(row.target_value),
    achievementValue: optNum(row.achievement_value),
    achievementUnits: optNum(row.achievement_units),
    hasTarget: row.has_target === true,
    hasActual: row.has_actual === true,
  }));
}

// ── Pure roll-ups (no IO) ─────────────────────────────────────────────────────
// Sum actuals + targets up the org hierarchy and recompute achievement from the
// SUMS (never average per-row %). Rows without the grouping key are skipped.
//
// The numerator is `coveredActualValue`, NOT `actualValue`. A percentage cannot be
// re-aggregated — only the parts it divides can — and the two parts have to describe
// the same population. `au.f_monthly_achievement` returns one row per
// (line, area, product): rows carrying a target row (`hasTarget`) and rows that do
// not. Only the covered ones have anything in the denominator, so dividing ALL sales
// by covered target credits a seat with revenue its target never asked for. Measured
// on production 2026-08-23, before this was fixed: Pedia February read 67.99% for a
// 35.71% month, and one district manager read 48.5% for a 2.2% July. This is the same
// rule `vs-target.ts` and `business-review/canonical.ts` already follow — see
// `addRow` in vs-target.ts, which is the definition this mirrors deliberately.
//
// `coveredActualValue` is NOT bounded above by `actualValue`: returns and credits land
// as negative rows and can be uncovered, so an untargeted line of pure returns makes
// the covered figure the LARGER of the two (CNS January 2026 does exactly this). Do
// not "correct" that with a clamp — both figures are right and the difference is real.

export type AchievementTotal = {
  actualValue: number;
  actualUnits: number;
  /**
   * The slice of `actualValue` sitting on a key that HAS a target — the numerator
   * `achievementValue` really divides. Carried on every total so a parent can be built
   * from children without re-deriving it, and so the UI can show WHICH sales were graded.
   */
  coveredActualValue: number;
  coveredActualUnits: number;
  targetValue: number;
  targetUnits: number;
  achievementValue: number | null;
};

function foldAchievement<K>(
  rows: AchievementRow[],
  keyOf: (row: AchievementRow) => K | null,
): Map<K, AchievementTotal> {
  const totals = new Map<K, AchievementTotal>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key == null) continue;
    const current = totals.get(key) ?? {
      actualValue: 0,
      actualUnits: 0,
      coveredActualValue: 0,
      coveredActualUnits: 0,
      targetValue: 0,
      targetUnits: 0,
      achievementValue: null,
    };
    current.actualValue += row.actualValue;
    current.actualUnits += row.actualUnits;
    if (row.hasTarget) {
      current.coveredActualValue += row.actualValue;
      current.coveredActualUnits += row.actualUnits;
    }
    current.targetValue += row.targetValue ?? 0;
    current.targetUnits += row.targetUnits ?? 0;
    totals.set(key, current);
  }
  for (const total of totals.values()) {
    // ALL of the group's actual over its target — the Monthly Closing's own division, which this
    // page must match to the piastre. Owner ruling 2026-09-05: "FOLLOW THE OLD MONTHLY CLOSING ...
    // MUST BE 100% IDENTICAL". `loadMonthlyAchievement` takes ONE period, so the across-months half
    // of that rule cannot arise here; it lives in vs-target.ts, which spans a window.
    //
    // This divided `coveredActualValue` until then, which is exactly what made this page and the
    // closing disagree wherever a group sold something nobody targeted: Pedia 2026-02 read 35.7%
    // here against the closing's 67.99%, and one district manager read 2.2% against 48.5%.
    //
    // `coveredActualValue` is still accumulated above — it is the coverage figure the page shows
    // BESIDE the percentage, and it is no longer the numerator inside it.
    total.achievementValue = total.targetValue !== 0 ? total.actualValue / total.targetValue : null;
  }
  return totals;
}

export type KeyedAchievement = AchievementTotal & { key: string };

const toKeyed = (map: Map<string, AchievementTotal>): KeyedAchievement[] =>
  [...map.entries()].map(([key, total]) => ({ key, ...total }));

/** Achievement per rep (indirect, resolved occupant only). */
export function rollupAchievementByRep(rows: AchievementRow[]): KeyedAchievement[] {
  return toKeyed(foldAchievement(rows, (row) => row.repHrId));
}

/** Achievement per DM (resolved occupant only). */
export function rollupAchievementByDm(rows: AchievementRow[]): KeyedAchievement[] {
  return toKeyed(foldAchievement(rows, (row) => row.dmHrId));
}

/** Separator for the (line, region) composite roll-up key (a control char, never in a code). */
const REGION_ROLLUP_SEPARATOR = "\u0001";

export type RegionAchievement = KeyedAchievement & { lineCode: string; regionCode: string };

/**
 * Achievement per (line, region). Carries the CLEAN line/region codes alongside the composite
 * key so callers display the region straight through regionName(regionCode) — never by parsing
 * the key (whose separator previously leaked the raw region code into the UI).
 */
export function rollupAchievementByRegion(rows: AchievementRow[]): RegionAchievement[] {
  const folded = foldAchievement(rows, (row) =>
    row.lineCode && row.regionCode ? `${row.lineCode}${REGION_ROLLUP_SEPARATOR}${row.regionCode}` : null,
  );
  return [...folded.entries()].map(([key, total]) => {
    const at = key.indexOf(REGION_ROLLUP_SEPARATOR);
    return {
      key,
      lineCode: at >= 0 ? key.slice(0, at) : key,
      regionCode: at >= 0 ? key.slice(at + 1) : "",
      ...total,
    };
  });
}

/** Achievement per line. */
export function rollupAchievementByLine(rows: AchievementRow[]): KeyedAchievement[] {
  return toKeyed(foldAchievement(rows, (row) => row.lineCode));
}

/** `null + null = null`; anything else sums, so "no target at all" stays distinguishable from 0. */
function addNullable(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0);
}

/**
 * Restore ONE row per (line, area, product) after an area merge has collapsed two areas onto one
 * code — `applyAchievementAreaMerges` rewrites `areaCode` and does not re-aggregate.
 *
 * `au.f_monthly_achievement` returns one row per (line, area, product), and every surface that
 * keys on that identity relies on it. The roll-ups above do not care, because they sum again
 * anyway; a KEYED surface does. The Targets grid keys its edit state, its React keys and its save
 * payload on `${areaCode}|${productCode}`, so after the Pedia GZ6/UE9 merge it rendered two rows
 * with the SAME key: both read one `edits` entry, `new Map(...)` kept only the last, and Save
 * posted a single `{ areaCode: "GZ6" }` that overwrote Fayoum while never touching Beni Suef.
 *
 * Owner ruling, restated 2026-09-05: on Pedia the pair is ONE area. So the merged cell carries ONE
 * target covering both halves, which is also the only arithmetically sound option — the row already
 * sums both areas' actuals, and a target covering one half would inflate attainment.
 *
 * `achievementValue`/`achievementUnits` are RECOMPUTED, never summed, from the covered slice only —
 * the same rule `foldAchievement` follows and for the same reason (see its note above: a percentage
 * cannot be re-aggregated, and dividing ALL sales by a covered target credits a seat with revenue
 * its target never asked for).
 *
 * ⚠ Do NOT feed the result to `foldAchievement` or the roll-ups. `hasTarget` is OR-ed here, so a
 * targeted area folded with an untargeted one produces one row whose ENTIRE actual would then count
 * as `coveredActualValue` — inflating exactly the number the covered rule exists to protect. Fold
 * for DISPLAY of a merged cell; roll up from the unfolded rows.
 */
export function foldMergedAchievementCells(rows: AchievementRow[]): AchievementRow[] {
  const byCell = new Map<string, AchievementRow>();
  const coveredValue = new Map<string, number>();
  const coveredUnits = new Map<string, number>();

  for (const row of rows) {
    const key = `${row.lineCode ?? ""}|${(row.areaCode ?? "").toUpperCase()}|${row.productCode.toUpperCase()}`;
    coveredValue.set(key, (coveredValue.get(key) ?? 0) + (row.hasTarget ? row.actualValue : 0));
    coveredUnits.set(key, (coveredUnits.get(key) ?? 0) + (row.hasTarget ? row.actualUnits : 0));

    const merged = byCell.get(key);
    if (!merged) {
      byCell.set(key, { ...row });
      continue;
    }
    merged.actualValue += row.actualValue;
    merged.actualUnits += row.actualUnits;
    merged.targetValue = addNullable(merged.targetValue, row.targetValue);
    merged.targetUnits = addNullable(merged.targetUnits, row.targetUnits);
    merged.hasTarget = merged.hasTarget || row.hasTarget;
    merged.hasActual = merged.hasActual || row.hasActual;
  }

  for (const [key, row] of byCell) {
    const targetValue = row.targetValue ?? 0;
    const targetUnits = row.targetUnits ?? 0;
    row.achievementValue = targetValue !== 0 ? (coveredValue.get(key) ?? 0) / targetValue : null;
    row.achievementUnits = targetUnits !== 0 ? (coveredUnits.get(key) ?? 0) / targetUnits : null;
  }
  return [...byCell.values()];
}

// ── UI helpers ────────────────────────────────────────────────────────────────

/** The three canonical sales lines (fixed per owner: CNS, Pedia, Anti-infective). */
export const SALES_LINES: ReadonlyArray<{ code: string; label: string }> = [
  { code: "cns", label: "CNS" },
  { code: "pedia", label: "Pedia" },
  { code: "anti_infective", label: "Anti-infective" },
];

export type TargetableArea = {
  areaCode: string;
  areaName: string;
  regionCode: string | null;
  areaState: string | null;
};

/** Fixed region code -> human name (never surface the code; see feedback-show-names-not-codes). */
export const REGION_NAMES: Record<string, string> = {
  AB: "Alex-BHR",
  CA: "Cairo",
  D1: "Delta 1",
  D2: "Delta 2",
  GZ: "Giza",
  OT: "Others",
  SH: "Sharkia",
  UE: "Upper Egypt",
  "UE-1": "Upper Egypt 1",
  "UE-2": "Upper Egypt 2",
  NATIONAL: "National",
};

export function regionName(code: string | null | undefined): string {
  const key = str(code).trim();
  return key ? (REGION_NAMES[key] ?? key) : "";
}

/**
 * line_code -> the official line name. Never show a code to a user (owner rule).
 *
 * The engine returns codes; every canonical read module needs the name. This map had been
 * copy-pasted into each of them, which is how two of them would eventually disagree about
 * what "anti_infective" is called. It lives here now, beside regionName, for the same reason.
 * An unknown code falls through to itself rather than to "" — a visible oddity beats a row
 * that silently loses its line.
 */
const LINE_NAMES: Record<string, string> = {
  cns: "CNS",
  pedia: "Pedia",
  anti_infective: "Anti Infective",
};

export function lineName(code: string | null | undefined): string {
  const key = str(code).trim();
  return key ? (LINE_NAMES[key] ?? key) : "";
}

/** product_code (upper) -> product name, for display (codes are never shown to the user). */
export async function loadProductNameMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const record of await loadProductMasterRows()) {
    const code = str(record.product_code).trim().toUpperCase();
    const name = str(record.product_name).trim();
    if (code) map.set(code, name || code);
  }
  return map;
}

/**
 * product_code (upper) -> factory price (EGP). Powers the grid's inline Units × Price → Value.
 *
 * `period` is REQUIRED, and deliberately so. A price can differ by period since 2026-09-28 —
 * Saginko is 111.15 through 2026-09 and 170.52 from 2026-10 — and a target valued at the wrong
 * one inflates achievement, because `target_value` is STORED while the sales it is divided into
 * are recomputed live. An optional argument would have let a call site keep the old behaviour
 * silently; a required one makes the compiler name every place that has to decide. Pass null only
 * where there genuinely is no period in hand — that falls back to the master price, which is the
 * same answer `public.phx_factory_price()` gives for a null period.
 */
export async function loadProductPriceMap(period: string | null): Promise<Map<string, number>> {
  return loadProductPriceMapForPeriod(period);
}

/** product_code (upper) -> family, for the family/therapeutic-area breakdowns. */
export async function loadProductFamilyMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const record of await loadProductMasterRows()) {
    const code = str(record.product_code).trim().toUpperCase();
    const family = str(record.family).trim();
    if (code && family) map.set(code, family);
  }
  return map;
}

/**
 * area_code (upper) -> area name, from the Source of Sales master.
 *
 * Deliberately the SoS master and not au_v_canonical_areas: the canonical view holds the 42
 * areas that carry a seat, while the engine also attributes to spillover/"Other" areas that
 * only exist in the master. Reading the narrower view would leave those rows labelled with a
 * raw code, and the owner's standing rule is names in the UI, never codes.
 *
 * The portal and the admin dashboard both resolve territory labels through here, so the same
 * area cannot be called two different things on two screens.
 */
export async function loadAreaNameMap(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("source_of_sales_areas").select("area_code,area_name");
  if (error) throw error;
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const code = str(record.area_code).trim().toUpperCase();
    const name = str(record.area_name).trim();
    if (code) map.set(code, name || code);
  }
  return map;
}

/**
 * How long one read of the employee names serves every caller in this process.
 *
 * Names only — display text for rep and manager rows, never an access, pay or scope decision — so a
 * rename showing up to a minute late is harmless. Measured 2026-10-31 on Sales vs Target: the full
 * `employees` read is usually 0.2–0.9 s but spiked to 4.5 s and 7.0 s, and those two spikes were the
 * two slowest page loads of the whole run. Every Sales vs Target render, the team-performance portal
 * and the dashboards each paid it again.
 */
export const EMPLOYEE_NAME_MAP_TTL_MS = 60_000;

const employeeNameMapMemo = new Map<string, SingleFlightEntry<Map<string, string>>>();

/**
 * hr_id -> employee display name (full name, else nickname), for rep/DM display.
 *
 * Served from a one-minute in-process memo through memoInFlight (crm/ttl-single-flight.ts): callers
 * arriving while a read runs share it, and a failed read is never remembered. Each caller gets its
 * own copy, so no caller can edit what the next one reads.
 */
export async function loadEmployeeNameMap(): Promise<Map<string, string>> {
  const shared = await memoInFlight(employeeNameMapMemo, "all", EMPLOYEE_NAME_MAP_TTL_MS, 1, loadEmployeeNameMapLive);
  return new Map(shared);
}

async function loadEmployeeNameMapLive(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("employees").select("hr_id,full_name,nickname");
  if (error) throw error;
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const hrId = str(record.hr_id).trim();
    if (!hrId) continue;
    const name = str(record.full_name).trim() || str(record.nickname).trim();
    if (name) map.set(hrId, name);
  }
  return map;
}

/** hr_id -> employees.employment_status, for the screens that must tell a leaver from a current employee. */
export async function loadEmployeeEmploymentStatusMap(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("employees").select("hr_id,employment_status");
  if (error) throw error;
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const hrId = str(record.hr_id).trim();
    const status = str(record.employment_status).trim();
    if (hrId && status) map.set(hrId, status);
  }
  return map;
}

// ── Source drill-down (traceability) ─────────────────────────────────────────
// Decompose a closing number to its raw source (distributor + brick). Reconciles
// exactly to au.f_monthly_attribution. Used by the expandable Targets rows + export.

export type SourceBreakdownRow = {
  productCode: string;
  productName: string;
  distributorName: string;
  brickName: string;
  units: number;
  value: number;
};

export type DirectBreakdownRow = {
  regionCode: string;
  regionName: string;
  productCode: string;
  productName: string;
  distributorName: string;
  units: number;
  value: number;
};

export type LineSourceBreakdownRow = SourceBreakdownRow & { areaCode: string };

/** Indirect distributor×brick breakdown for one (period, line, area[, product]). */
export async function loadSourceBreakdown(
  period: string,
  lineCode: string,
  areaCode: string,
  productCode?: string | null,
): Promise<SourceBreakdownRow[]> {
  if (!isValidPeriod(period) || !lineCode || !areaCode) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_sales_source_breakdown", {
    p_period: period,
    p_line_code: lineCode,
    p_area_code: areaCode,
    p_product_code: productCode ?? null,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    productCode: str(row.product_code),
    productName: str(row.product_name) || str(row.product_code),
    distributorName: str(row.distributor_name),
    brickName: str(row.brick_name),
    units: num(row.units),
    value: num(row.value),
  }));
}

/** Direct (company) channel breakdown for one (period, line). */
export async function loadDirectBreakdown(period: string, lineCode: string): Promise<DirectBreakdownRow[]> {
  if (!isValidPeriod(period) || !lineCode) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_sales_direct_breakdown", {
    p_period: period,
    p_line_code: lineCode,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    regionCode: str(row.region_code),
    regionName: regionName(str(row.region_code)),
    productCode: str(row.product_code),
    productName: str(row.product_name) || str(row.product_code),
    distributorName: str(row.distributor_name),
    units: num(row.units),
    value: num(row.value),
  }));
}

export type SourceDetailRow = {
  brickName: string;
  distributorName: string;
  customerName: string;
  units: number;
  value: number;
};

/** Customer-grain source: brick → distributor → customer (named) for one (period, line, area, product). */
export async function loadSourceBreakdownDetail(
  period: string,
  lineCode: string,
  areaCode: string,
  productCode: string,
): Promise<SourceDetailRow[]> {
  if (!isValidPeriod(period) || !lineCode || !areaCode) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_sales_source_breakdown_detail", {
    p_period: period,
    p_line_code: lineCode,
    p_area_code: areaCode,
    p_product_code: productCode || null,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    brickName: str(row.brick_name),
    distributorName: str(row.distributor_name),
    customerName: str(row.customer_name),
    units: num(row.units),
    value: num(row.value),
  }));
}

export type AreaTrendPoint = { period: string; units: number; value: number };

/** Month-over-month trend for one (line, area[, product]) across the loaded months. */
export async function loadAreaTrend(lineCode: string, areaCode: string, productCode?: string | null): Promise<AreaTrendPoint[]> {
  if (!lineCode || !areaCode) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_sales_area_trend", {
    p_line_code: lineCode,
    p_area_code: areaCode,
    p_product_code: productCode ?? null,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    period: str(row.period),
    units: num(row.units),
    value: num(row.value),
  }));
}

export type SourceFileRow = {
  distributorName: string;
  fileName: string;
  uploadedBy: string;
  uploadedAt: string;
  totalQty: number;
  totalValue: number;
  importableRows: number;
  status: string;
};

/** The validated distributor uploads that fed a month (provenance / paper-trail). */
export async function loadSourceFiles(period: string): Promise<SourceFileRow[]> {
  if (!isValidPeriod(period)) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_sales_source_files", { p_period: period });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    distributorName: str(row.distributor_name),
    fileName: str(row.file_name),
    uploadedBy: str(row.uploaded_by),
    uploadedAt: str(row.uploaded_at),
    totalQty: num(row.total_qty),
    totalValue: num(row.total_value),
    importableRows: num(row.importable_rows),
    status: str(row.status),
  }));
}

/** Whole-line indirect breakdown (all areas) — for the Excel audit export. */
export async function loadLineSourceBreakdown(period: string, lineCode: string): Promise<LineSourceBreakdownRow[]> {
  if (!isValidPeriod(period) || !lineCode) return [];
  const supabase = getSupabaseAdmin();
  const rows = await rpcAll<Record<string, unknown>>(
    supabase,
    "phx_sales_source_breakdown_line",
    { p_period: period, p_line_code: lineCode },
    ["area_code", "product_code"],
  );
  return rows.map((row) => ({
    areaCode: str(row.area_code),
    productCode: str(row.product_code),
    productName: str(row.product_name) || str(row.product_code),
    distributorName: str(row.distributor_name),
    brickName: str(row.brick_name),
    units: num(row.units),
    value: num(row.value),
  }));
}

/** Areas that CARRY a target for a line (occupied + vacant; excludes "Other"). */
export async function loadTargetableAreas(lineCode: string): Promise<TargetableArea[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("au_v_line_area_map")
    .select("line_code,area_code,area_name,operational_region_code,area_state,carries_target")
    .eq("line_code", lineCode)
    .eq("carries_target", true)
    .order("area_code");
  if (error) throw error;
  const areas = (data ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      areaCode: str(record.area_code),
      areaName: str(record.area_name),
      regionCode: str(record.operational_region_code) || null,
      areaState: str(record.area_state) || null,
    };
  });

  // ONE option per merged pair. `au_v_line_area_map` carries Pedia's GZ6 and UE9 as two rows, both
  // `carries_target = true`, so the download template used to offer "Beni Suef" as its own target
  // area for Pedia — a target nobody can then see or edit, because the grid renders the pair as the
  // single merged row "Fayoum - Beni Suef" (owner: on Pedia they are one area). Offering a cell that
  // the only screen able to display it will never show is how a target gets authored and lost.
  //
  // No `expandAreaCodeForLine` is needed here, unlike a picker: the code chosen here is not scoping
  // a query, it IS the cell the target is stored on, and the merged pair's target belongs to the
  // keep-code by that same ruling. CNS and Anti Infective have no rule and pass through untouched.
  return foldAreaOptionsForLine(lineCode, areas);
}

export type TargetableProduct = {
  productCode: string;
  productName: string;
  factoryPrice: number | null;
};

/** lineCode -> normalized_line as stored on source_of_sales_products (anti_infective → "anti infective"). */
const LINE_TO_NORMALIZED_LINE: Record<string, string> = {
  cns: "cns",
  pedia: "pedia",
  anti_infective: "anti infective",
};

/**
 * Products that may carry a field target for a line: active + non-confidential, with their
 * factory price. Feeds the smart upload template's Product dropdown and the unit-price /
 * value auto-fill. Confidential products (LA003/LA004/SS001) are excluded here for the same
 * reason validateTargetRows rejects them — a target row would otherwise surface the name.
 *
 * `period` is the period the targets being authored belong to, and the price is resolved for it —
 * see loadProductPriceMap above for why that matters on the TARGET side. For a template spanning a
 * quarter or a semester, pass the FIRST period of the span: a span that straddles a price change
 * would otherwise have to carry two prices in one column, and every span the screen offers (a
 * quarter, a semester) sits entirely on one side of 1 October.
 */
export async function loadTargetableProducts(
  lineCode: string,
  period: string | null,
): Promise<TargetableProduct[]> {
  const supabase = getSupabaseAdmin();
  const normalizedLine = LINE_TO_NORMALIZED_LINE[lineCode] ?? lineCode;
  const [{ data, error }, prices] = await Promise.all([
    supabase
      .from("source_of_sales_products")
      .select("product_code,product_name,factory_price,active,normalized_line")
      .eq("normalized_line", normalizedLine)
      .eq("active", true)
      .order("product_name"),
    loadProductPeriodPrices(),
  ]);
  if (error) throw error;
  const products: TargetableProduct[] = [];
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const code = str(record.product_code).trim().toUpperCase();
    if (!code || CONFIDENTIAL_PRODUCT_CODES.has(code)) continue;
    products.push({
      productCode: code,
      productName: str(record.product_name).trim() || code,
      factoryPrice: prices.priceFor(code, period) ?? optNum(record.factory_price),
    });
  }
  return products;
}

/**
 * area_code -> area_name for ALL 42 canonical areas (line-independent; a canonical area's
 * name never varies by line, only its region/rep/DM/carries_target do). Use this for DISPLAY
 * so "Other" areas — excluded from loadTargetableAreas — still resolve to a real name instead
 * of falling back to a blank/code in the UI.
 */
export async function loadAllCanonicalAreaNames(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("au_v_canonical_areas").select("area_code,area_name");
  if (error) throw error;
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const code = str(record.area_code).trim();
    if (code) map.set(code, str(record.area_name).trim() || code);
  }
  return map;
}
