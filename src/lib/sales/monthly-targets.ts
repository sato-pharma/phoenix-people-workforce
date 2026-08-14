import { getSupabaseAdmin, rpcAll } from "@/lib/supabase/server";

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

  const [mapResult, productResult] = await Promise.all([
    supabase.from("au_v_line_area_map").select("line_code,area_code,area_name,carries_target"),
    supabase.from("source_of_sales_products").select("product_code,product_name,normalized_line,active"),
  ]);

  if (mapResult.error) throw mapResult.error;
  if (productResult.error) throw productResult.error;

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

  for (const row of productResult.data ?? []) {
    const record = row as Record<string, unknown>;
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

    valid.push({
      period: row.period,
      line_code: lineCode,
      area_code: areaCode,
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

export type AchievementTotal = {
  actualValue: number;
  actualUnits: number;
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
    const current = totals.get(key) ?? { actualValue: 0, actualUnits: 0, targetValue: 0, targetUnits: 0, achievementValue: null };
    current.actualValue += row.actualValue;
    current.actualUnits += row.actualUnits;
    current.targetValue += row.targetValue ?? 0;
    current.targetUnits += row.targetUnits ?? 0;
    totals.set(key, current);
  }
  for (const total of totals.values()) {
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
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("source_of_sales_products").select("product_code,product_name");
  if (error) throw error;
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const code = str(record.product_code).trim().toUpperCase();
    const name = str(record.product_name).trim();
    if (code) map.set(code, name || code);
  }
  return map;
}

/** product_code (upper) -> factory price (EGP). Powers the grid's inline Units × Price → Value. */
export async function loadProductPriceMap(): Promise<Map<string, number>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("source_of_sales_products").select("product_code,factory_price");
  if (error) throw error;
  const map = new Map<string, number>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const code = str(record.product_code).trim().toUpperCase();
    const price = optNum(record.factory_price);
    if (code && price != null) map.set(code, price);
  }
  return map;
}

/** product_code (upper) -> family, for the family/therapeutic-area breakdowns. */
export async function loadProductFamilyMap(): Promise<Map<string, string>> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("source_of_sales_products").select("product_code,family");
  if (error) throw error;
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
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

/** hr_id -> employee display name (full name, else nickname), for rep/DM display. */
export async function loadEmployeeNameMap(): Promise<Map<string, string>> {
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
  return (data ?? []).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      areaCode: str(record.area_code),
      areaName: str(record.area_name),
      regionCode: str(record.operational_region_code) || null,
      areaState: str(record.area_state) || null,
    };
  });
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
 */
export async function loadTargetableProducts(lineCode: string): Promise<TargetableProduct[]> {
  const supabase = getSupabaseAdmin();
  const normalizedLine = LINE_TO_NORMALIZED_LINE[lineCode] ?? lineCode;
  const { data, error } = await supabase
    .from("source_of_sales_products")
    .select("product_code,product_name,factory_price,active,normalized_line")
    .eq("normalized_line", normalizedLine)
    .eq("active", true)
    .order("product_name");
  if (error) throw error;
  const products: TargetableProduct[] = [];
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    const code = str(record.product_code).trim().toUpperCase();
    if (!code || CONFIDENTIAL_PRODUCT_CODES.has(code)) continue;
    products.push({
      productCode: code,
      productName: str(record.product_name).trim() || code,
      factoryPrice: optNum(record.factory_price),
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
