/**
 * Production Planner — the server half.
 *
 * Every exported function takes the `AccessContext` FIRST, resolves this module's level from it and
 * asserts before it reads or writes anything. The gate is `resolveProductionPlanningLevel`, not
 * `assertPermission`, because two of the five people the owner named hold app roles that the matrix
 * deliberately grants nothing — see src/lib/production-planning/access.ts for why.
 *
 * ── Everything on the wire is a STRING ───────────────────────────────────────────────────────────
 *
 * Quantities are BigInt counts of micro base units inside this module, and `JSON.stringify` cannot
 * carry a BigInt. So every quantity leaves here as its decimal TEXT and the client formats it. That
 * is not a workaround: it is the same reason every quantity column is read with `select("qty::text")`
 * — PostgREST serialises `numeric` as a JSON number, so a value that is not cast has already been
 * through a double before this file sees it, and the figure on screen stops matching the formula in
 * the Excel export.
 */
import { writeAuditLog, writeRequiredAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdForStorage } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  assertProductionPlanningRead,
  assertProductionPlanningWrite,
  type ProductionPlanningLevel,
} from "./access";
import { resolveProductionPlanningLevel } from "./access-db";
import { evaluateAlarms, resolveAlarmArming, resolveFxArming, thresholdRunsToMicro } from "./alarm";
import {
  costQuantity,
  formatMoney,
  resolveEffectiveFxRate,
  totalCosts,
  type Currency,
  type EffectiveFxRate,
  type LineCost,
} from "./costing";
import { formatExactRuns, resolveRunGeometry, type RunGeometry } from "./geometry";
import { formatOveragePct, learnFromRuns, resolveOverage, type MaterialLearning, type RunObservation } from "./learning";
import type { WireRun, WireWorkspace } from "./wire";
import {
  resolveMaterialRequirement,
  sortRequirements,
  summariseRequirements,
  type MaterialRequirement,
  type MaterialRequirementInput,
  type OverageSource,
} from "./requirements";
import {
  COMPOSITION_BASES,
  formatPct,
  formatQty,
  MATERIAL_SUPPLIERS,
  parseNonNegativeQty,
  parsePct,
  parseQty,
  parseWholeCount,
  PLAN_REQUEST_MODES,
  ProductionPlanningInputError,
  QTY_SCALE,
  fromDisplayQty,
  toDisplayQty,
  UNIT_KINDS,
  type CompositionBasis,
  type MaterialSupplier,
  type PlanRequestMode,
  type UnitKind,
} from "./rules";
import { buildPlannerSentence, formatNumberLatin, PP } from "./strings";

const T = {
  products: "prodplan_products",
  materials: "prodplan_materials",
  compositions: "prodplan_compositions",
  locations: "prodplan_locations",
  stock: "prodplan_stock_entries",
  prices: "prodplan_material_prices",
  fx: "prodplan_fx_rates",
  settings: "prodplan_settings",
  plans: "prodplan_plans",
  planLines: "prodplan_plan_lines",
  runs: "prodplan_runs",
  runMaterials: "prodplan_run_materials",
  alarms: "prodplan_alarm_events",
  grants: "prodplan_access_grants",
} as const;

/**
 * The same table names, for the two cron sweeps.
 *
 * Exported rather than re-typed there: a table name written twice is a table name that can be
 * renamed once, and a PostgREST read of a table that does not exist answers PGRST205 — not 42P01 —
 * which reads like an empty result rather than a missing table.
 */
export { T as PRODPLAN_TABLES };

// Explicit column lists, never `select("*")`: a `*` read is how a column added for one screen
// quietly starts travelling to every other one.
const PRODUCT_COLUMNS =
  "id, code, name_ar, name_en, manufacturer_name, run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box, is_active, notes";
const MATERIAL_COLUMNS =
  "id, code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display::text, is_imported, lead_time_days, min_order_qty::text, purchase_increment::text, reorder_cover_runs::text, is_active, sort_order, notes";
const COMPOSITION_COLUMNS =
  "id, product_id, material_id, unit_kind, basis, qty_per_basis::text, supplier, overage_pct::text, effective_from, effective_to, notes";
const LOCATION_COLUMNS = "id, code, name_ar, name_en, is_factory, is_active, sort_order";
const STOCK_COLUMNS = "id, material_id, unit_kind, location_id, qty::text, as_of_date, source, note, created_at";
const PRICE_COLUMNS =
  "id, material_id, unit_kind, currency, price_per_display_unit::text, effective_from, supplier_name, note, created_at";
const FX_COLUMNS =
  "rate_date, fetched_usd_to_egp::text, fetch_ok, fetch_source, fetch_error, manual_usd_to_egp::text, manual_note";
const SETTINGS_COLUMNS =
  "id, default_overage_pct::text, reorder_cover_runs::text, alarm_enabled, alarm_dry_run, fx_fetch_enabled, fx_fetch_dry_run, fx_fallback_usd_to_egp::text, alarm_last_evaluated_on, alarm_last_sent_on, updated_by_hr_id, updated_by_login, updated_at";
const RUN_COLUMNS =
  "id, product_id, plan_id, run_label, runs_count, actual_good_units, actual_sample_units, snap_run_volume_ml, snap_dose_ml, snap_good_unit_ml, snap_sample_unit_ml, produced_on, is_excluded_from_learning, exclusion_reason, notes, recorded_by_login, created_at";
const RUN_MATERIAL_COLUMNS =
  "id, run_id, material_id, unit_kind, opening_qty::text, delivered_qty::text, closing_qty::text, consumed_qty::text, theoretical_qty::text, note";
const PLAN_COLUMNS =
  "id, product_id, title, request_mode, requested_qty, sample_units, status, snap_overage_pct::text, snap_runs, snap_good_units, snap_packaging_sets, snap_fx_usd_to_egp::text, snap_fx_rate_date, notes, created_by_login, committed_at, committed_by_login, created_at";

function failure(error: { message?: string } | null, what: string): never {
  throw new Error(`Could not ${what}: ${error?.message ?? "unknown error"}`);
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Every field on a request body is `unknown` on purpose, and the parsers in rules.ts take
 * `string | number | bigint | null`. This is the narrowing both ends agree on: anything else — an
 * object, an array, a boolean a client sent where a quantity belongs — reads as ABSENT, so the
 * parser rejects it or applies its own default. Passing the `unknown` straight through compiled
 * nowhere (TS2345, 17 sites), and casting it would have handed `parseQty` an object to stringify.
 */
function asScalar(value: unknown): string | number | bigint | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  return null;
}

function optionalQty(value: unknown, field: string): bigint | null {
  const text = asText(value);
  return text === null ? null : parseNonNegativeQty(text, field);
}

function todayCairo(): string {
  // Cairo, because a stock report dated "today" means today where the factory and the office are.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

function actor(access: AccessContext) {
  return {
    hrId: hrIdForStorage(access.hrId),
    login: access.loginId ?? hrIdForStorage(access.hrId) ?? "unknown",
  };
}

// ── Loading ────────────────────────────────────────────────────────────────────────────────────────

export type LoadedProduct = {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly manufacturerName: string | null;
  readonly geometry: RunGeometry;
  readonly notes: string | null;
};

export type LoadedLocation = {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly isFactory: boolean;
};

export type LoadedMaterial = {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly unitKind: UnitKind;
  readonly baseUnit: string;
  readonly displayUnit: string;
  readonly basePerDisplay: bigint;
  readonly isImported: boolean;
  readonly leadTimeDays: number | null;
  readonly minOrderQty: bigint | null;
  readonly purchaseIncrement: bigint | null;
  readonly reorderCoverRuns: bigint | null;
  readonly sortOrder: number;
  readonly notes: string | null;
};

export type LoadedComposition = {
  readonly materialId: string;
  readonly basis: CompositionBasis;
  readonly qtyPerBasis: bigint;
  readonly supplier: MaterialSupplier;
  readonly overagePct: bigint | null;
  readonly effectiveFrom: string;
  readonly notes: string | null;
};

export type LoadedStock = {
  readonly materialId: string;
  readonly locationId: string;
  readonly qty: bigint;
  readonly asOfDate: string;
  readonly source: string;
  readonly note: string | null;
};

export type LoadedPrice = {
  readonly materialId: string;
  readonly currency: Currency;
  readonly pricePerDisplayUnit: bigint;
  readonly effectiveFrom: string;
  readonly supplierName: string | null;
};

export type LoadedSettings = {
  readonly defaultOveragePct: bigint;
  readonly reorderCoverRuns: bigint;
  readonly alarmEnabled: boolean;
  readonly alarmDryRun: boolean;
  readonly fxFetchEnabled: boolean;
  readonly fxFetchDryRun: boolean;
  readonly fxFallbackUsdToEgp: bigint | null;
  readonly alarmLastEvaluatedOn: string | null;
  readonly alarmLastSentOn: string | null;
  readonly updatedByLogin: string | null;
  readonly updatedAt: string | null;
};

/** Everything the planner needs in one shape, loaded once per request. */
export type ProductionPlanningData = {
  readonly level: ProductionPlanningLevel;
  readonly products: LoadedProduct[];
  readonly locations: LoadedLocation[];
  readonly materials: LoadedMaterial[];
  readonly compositionsByProductId: Map<string, LoadedComposition[]>;
  readonly stock: LoadedStock[];
  readonly prices: LoadedPrice[];
  readonly settings: LoadedSettings;
  readonly fx: EffectiveFxRate;
  readonly learning: Map<string, MaterialLearning>;
};

const DEFAULT_SETTINGS: LoadedSettings = {
  defaultOveragePct: parsePct("3"),
  reorderCoverRuns: QTY_SCALE,
  // Fail-safe: a settings row that will not load must not be able to arm the email.
  alarmEnabled: false,
  alarmDryRun: true,
  fxFetchEnabled: false,
  fxFetchDryRun: true,
  fxFallbackUsdToEgp: null,
  alarmLastEvaluatedOn: null,
  alarmLastSentOn: null,
  updatedByLogin: null,
  updatedAt: null,
};

export async function loadProductionPlanningData(access: AccessContext): Promise<ProductionPlanningData> {
  const level = await resolveProductionPlanningLevel(access);
  assertProductionPlanningRead(access, level);
  return loadProductionPlanningDataAtLevel(level);
}

/**
 * The same read with NO person behind it — for the two crons, which are authorised by CRON_SECRET
 * and have no session to resolve a level from. Deliberately not reachable from an API route: the
 * only callers are `reorder-sweep.ts` and `fx-sweep.ts`, and the level it reports is the one a
 * sweep needs to read everything. A route that called this instead of the gated function above
 * would be a module-wide authorisation hole, so it is named loudly enough to notice in review.
 */
export async function loadProductionPlanningDataForSystem(): Promise<ProductionPlanningData> {
  return loadProductionPlanningDataAtLevel("full");
}

async function loadProductionPlanningDataAtLevel(level: ProductionPlanningLevel): Promise<ProductionPlanningData> {
  const db = getSupabaseAdmin();
  const today = todayCairo();

  const [productsRes, materialsRes, compositionsRes, locationsRes, stockRes, pricesRes, settingsRes, fxRes] =
    await Promise.all([
      db.from(T.products).select(PRODUCT_COLUMNS).eq("is_active", true).order("code"),
      db.from(T.materials).select(MATERIAL_COLUMNS).eq("is_active", true).order("sort_order").order("code"),
      db.from(T.compositions).select(COMPOSITION_COLUMNS).lte("effective_from", today).order("effective_from", { ascending: false }),
      db.from(T.locations).select(LOCATION_COLUMNS).eq("is_active", true).order("sort_order"),
      db.from(T.stock).select(STOCK_COLUMNS).order("as_of_date", { ascending: false }).order("created_at", { ascending: false }),
      db.from(T.prices).select(PRICE_COLUMNS).lte("effective_from", today).order("effective_from", { ascending: false }),
      db.from(T.settings).select(SETTINGS_COLUMNS).eq("id", 1).maybeSingle(),
      db.from(T.fx).select(FX_COLUMNS).lte("rate_date", today).order("rate_date", { ascending: false }).limit(1).maybeSingle(),
    ]);

  if (productsRes.error) failure(productsRes.error, "load the products");
  if (materialsRes.error) failure(materialsRes.error, "load the materials");
  if (compositionsRes.error) failure(compositionsRes.error, "load the composition");
  if (locationsRes.error) failure(locationsRes.error, "load the stock locations");
  if (stockRes.error) failure(stockRes.error, "load the stock");
  if (pricesRes.error) failure(pricesRes.error, "load the prices");

  const products: LoadedProduct[] = (productsRes.data ?? []).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    nameAr: String(row.name_ar),
    nameEn: String(row.name_en),
    manufacturerName: asText(row.manufacturer_name),
    notes: asText(row.notes),
    geometry: {
      runVolumeMl: BigInt(row.run_volume_ml),
      doseMl: BigInt(row.dose_ml),
      goodUnitMl: BigInt(row.good_unit_ml),
      sampleUnitMl: BigInt(row.sample_unit_ml),
      wholeRunsOnly: row.whole_runs_only !== false,
      unitsPerBox: BigInt(row.units_per_box),
    },
  }));

  const materials: LoadedMaterial[] = (materialsRes.data ?? []).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    nameAr: String(row.name_ar),
    nameEn: String(row.name_en),
    unitKind: row.unit_kind === "count" ? "count" : "mass",
    baseUnit: String(row.base_unit),
    displayUnit: String(row.display_unit),
    basePerDisplay: parseQty(String(row.base_per_display), "base_per_display"),
    isImported: row.is_imported === true,
    leadTimeDays: typeof row.lead_time_days === "number" ? row.lead_time_days : null,
    minOrderQty: optionalQty(row.min_order_qty, "min_order_qty"),
    purchaseIncrement: optionalQty(row.purchase_increment, "purchase_increment"),
    reorderCoverRuns: optionalQty(row.reorder_cover_runs, "reorder_cover_runs"),
    sortOrder: typeof row.sort_order === "number" ? row.sort_order : 100,
    notes: asText(row.notes),
  }));

  // Newest effective row per (product, material) that is in force today. The query already sorted
  // effective_from descending, so the first one wins and the rest are history.
  const compositionsByProductId = new Map<string, LoadedComposition[]>();
  const seenComposition = new Set<string>();
  for (const row of compositionsRes.data ?? []) {
    const productId = String(row.product_id);
    const materialId = String(row.material_id);
    const closesOn = asText(row.effective_to);
    if (closesOn !== null && closesOn <= today) continue;
    const key = `${productId}/${materialId}`;
    if (seenComposition.has(key)) continue;
    seenComposition.add(key);
    const basis = COMPOSITION_BASES.find((candidate) => candidate === row.basis);
    const supplier = MATERIAL_SUPPLIERS.find((candidate) => candidate === row.supplier);
    if (!basis || !supplier) continue;
    const list = compositionsByProductId.get(productId) ?? [];
    list.push({
      materialId,
      basis,
      qtyPerBasis: parseQty(String(row.qty_per_basis), "qty_per_basis"),
      supplier,
      overagePct: asText(row.overage_pct) === null ? null : parsePct(String(row.overage_pct), "overage_pct"),
      effectiveFrom: String(row.effective_from),
      notes: asText(row.notes),
    });
    compositionsByProductId.set(productId, list);
  }

  const locations: LoadedLocation[] = (locationsRes.data ?? []).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    nameAr: String(row.name_ar),
    nameEn: String(row.name_en),
    isFactory: row.is_factory === true,
  }));

  // Newest report per (material, location). Append-only means the history is all here; the current
  // figure is the first row for each pair, which is why the query sorts before this loop.
  const stock: LoadedStock[] = [];
  const seenStock = new Set<string>();
  for (const row of stockRes.data ?? []) {
    const key = `${String(row.material_id)}/${String(row.location_id)}`;
    if (seenStock.has(key)) continue;
    seenStock.add(key);
    stock.push({
      materialId: String(row.material_id),
      locationId: String(row.location_id),
      qty: parseNonNegativeQty(String(row.qty), "qty"),
      asOfDate: String(row.as_of_date),
      source: String(row.source),
      note: asText(row.note),
    });
  }

  const prices: LoadedPrice[] = [];
  const seenPrice = new Set<string>();
  for (const row of pricesRes.data ?? []) {
    const materialId = String(row.material_id);
    if (seenPrice.has(materialId)) continue;
    seenPrice.add(materialId);
    prices.push({
      materialId,
      currency: row.currency === "USD" ? "USD" : "EGP",
      pricePerDisplayUnit: parseQty(String(row.price_per_display_unit), "price_per_display_unit"),
      effectiveFrom: String(row.effective_from),
      supplierName: asText(row.supplier_name),
    });
  }

  const settingsRow = settingsRes.data ?? null;
  // Through alarm.ts's own helpers rather than repeating the comparison here: the screen and the
  // cron must not be able to disagree about what "armed" means, and those two are what
  // tests/production-planning-engine.test.ts pins. Both read fail-safe — anything but an explicit
  // boolean leaves the email switched off and silent.
  const alarmArming = resolveAlarmArming(settingsRow);
  const fxArming = resolveFxArming(settingsRow);
  const settings: LoadedSettings = settingsRow
    ? {
        defaultOveragePct: parsePct(String(settingsRow.default_overage_pct), "default_overage_pct"),
        reorderCoverRuns: parseNonNegativeQty(String(settingsRow.reorder_cover_runs), "reorder_cover_runs"),
        alarmEnabled: alarmArming.enabled,
        alarmDryRun: alarmArming.dryRun,
        fxFetchEnabled: fxArming.enabled,
        fxFetchDryRun: fxArming.dryRun,
        fxFallbackUsdToEgp: optionalQty(settingsRow.fx_fallback_usd_to_egp, "fx_fallback_usd_to_egp"),
        alarmLastEvaluatedOn: asText(settingsRow.alarm_last_evaluated_on),
        alarmLastSentOn: asText(settingsRow.alarm_last_sent_on),
        updatedByLogin: asText(settingsRow.updated_by_login),
        updatedAt: asText(settingsRow.updated_at),
      }
    : DEFAULT_SETTINGS;

  const fxRow = fxRes.data ?? null;
  const fx = resolveEffectiveFxRate(
    fxRow
      ? {
          rateDate: String(fxRow.rate_date),
          fetchedUsdToEgp: optionalQty(fxRow.fetched_usd_to_egp, "fetched_usd_to_egp"),
          fetchOk: fxRow.fetch_ok === true,
          manualUsdToEgp: optionalQty(fxRow.manual_usd_to_egp, "manual_usd_to_egp"),
        }
      : null,
    settings.fxFallbackUsdToEgp,
  );

  return {
    level,
    products,
    locations,
    materials,
    compositionsByProductId,
    stock,
    prices,
    settings,
    fx,
    learning: await loadLearning(),
  };
}

/** Every recorded run's actuals, folded into one measured overage per material. */
async function loadLearning(): Promise<Map<string, MaterialLearning>> {
  const db = getSupabaseAdmin();
  const [runsRes, runMaterialsRes] = await Promise.all([
    db.from(T.runs).select("id, runs_count, is_excluded_from_learning"),
    db.from(T.runMaterials).select("run_id, material_id, consumed_qty::text, theoretical_qty::text"),
  ]);
  if (runsRes.error || runMaterialsRes.error) return new Map();

  const runsById = new Map<string, { runsCount: bigint; excluded: boolean }>();
  for (const row of runsRes.data ?? []) {
    runsById.set(String(row.id), {
      runsCount: BigInt(row.runs_count ?? 1),
      excluded: row.is_excluded_from_learning === true,
    });
  }

  const observations: RunObservation[] = [];
  for (const row of runMaterialsRes.data ?? []) {
    const run = runsById.get(String(row.run_id));
    if (!run) continue;
    observations.push({
      runId: String(row.run_id),
      materialId: String(row.material_id),
      consumedQty: parseQty(String(row.consumed_qty ?? "0"), "consumed_qty"),
      theoreticalQty: optionalQty(row.theoretical_qty, "theoretical_qty"),
      runsCount: run.runsCount,
      isExcludedFromLearning: run.excluded,
    });
  }
  return learnFromRuns(observations);
}

// ── Computing one plan ─────────────────────────────────────────────────────────────────────────────

export type PlanRequestInput = {
  readonly productId?: unknown;
  readonly mode?: unknown;
  readonly requestedQty?: unknown;
  readonly sampleUnits?: unknown;
  /** An overage typed on the screen for this one calculation, overriding every other source. */
  readonly overridePct?: unknown;
  /** Per material, what he has decided to deliver — keyed by material id, as a decimal string. */
  readonly willSendByMaterialId?: unknown;
};

export function parsePlanRequest(body: PlanRequestInput, data: ProductionPlanningData) {
  const productId = asText(body.productId) ?? data.products[0]?.id ?? null;
  if (!productId) throw new ProductionPlanningInputError("لا يوجد منتج لحساب احتياجه.", "productId");
  const product = data.products.find((candidate) => candidate.id === productId);
  if (!product) throw new ProductionPlanningInputError("المنتج غير موجود.", "productId");

  const mode = (PLAN_REQUEST_MODES.find((candidate) => candidate === body.mode) ?? "total_boxes") as PlanRequestMode;
  const requestedQty = parseWholeCount(asScalar(body.requestedQty) ?? 0, "requestedQty", { min: BigInt(1), max: BigInt(100_000_000) });
  const sampleUnits = parseWholeCount(asScalar(body.sampleUnits) ?? 0, "sampleUnits", { min: BigInt(0), max: BigInt(100_000_000) });
  const overridePct = asText(body.overridePct) === null ? null : parsePct(String(body.overridePct), "overridePct");

  const willSendByMaterialId = new Map<string, bigint>();
  if (body.willSendByMaterialId && typeof body.willSendByMaterialId === "object") {
    for (const [materialId, raw] of Object.entries(body.willSendByMaterialId as Record<string, unknown>)) {
      const text = asText(raw);
      if (text === null) continue;
      willSendByMaterialId.set(materialId, parseNonNegativeQty(text, `willSend:${materialId}`));
    }
  }

  return { product, mode, requestedQty, sampleUnits, overridePct, willSendByMaterialId };
}

export type PlanResultRow = {
  readonly materialId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly unitKind: UnitKind;
  readonly displayUnit: string;
  readonly supplier: MaterialSupplier | null;
  readonly basis: CompositionBasis | null;
  readonly overagePct: string;
  readonly overageSource: OverageSource;
  readonly isImported: boolean;
  readonly leadTimeDays: number | null;
  readonly basisCount: string;
  /** Display units — kilograms, pieces — because that is what he reads and types. */
  readonly rawNeeded: string;
  readonly needed: string;
  readonly neededPerRun: string;
  readonly heldAtFactory: string;
  readonly heldElsewhere: string;
  readonly heldTotal: string;
  readonly toBuy: string;
  readonly minToDeliver: string;
  readonly willSend: string;
  readonly balanceAfter: string;
  readonly balanceAfterRuns: string | null;
  readonly coverRuns: string | null;
  readonly contributesToBuyList: boolean;
  readonly excludedReason: MaterialRequirement["excludedReason"];
  readonly priceCurrency: Currency | null;
  readonly pricePerDisplayUnit: string | null;
  readonly costUsd: string | null;
  readonly costEgp: string | null;
  readonly costDerivedMissing: boolean;
};

export type PlanResult = {
  readonly productId: string;
  readonly productNameAr: string;
  readonly mode: PlanRequestMode;
  readonly requestedQty: string;
  readonly sampleUnits: string;
  readonly runs: string;
  readonly exactRuns: string;
  readonly rounded: boolean;
  readonly goodUnits: string;
  readonly packagingSets: string;
  readonly totalBoxes: string;
  readonly requestedBoxes: string;
  readonly surplusBoxes: string;
  readonly totalVolumeMl: string;
  readonly totalVolumeLitres: string;
  readonly runVolumeLitres: string;
  readonly totalDoses: string;
  readonly leftoverMl: string;
  readonly oneRunFewer: { runs: string; totalBoxes: string; shortfallBoxes: string } | null;
  readonly sentence: string;
  readonly rows: PlanResultRow[];
  readonly totals: {
    readonly materials: number;
    readonly toBuyCount: number;
    readonly unsettled: number;
    readonly factorySupplied: number;
    readonly withoutComposition: number;
    readonly shortAfterRunCount: number;
    readonly costUsd: string;
    readonly costEgp: string;
    readonly unpricedMaterials: number;
    readonly incompleteMaterials: number;
    readonly fxRate: string | null;
    readonly fxSource: EffectiveFxRate["source"];
    readonly fxRateDate: string | null;
  };
};

/**
 * Micro base units into the display unit the owner reads, as a decimal string.
 *
 * `toDisplayQty` from the kernel does the arithmetic, so the screen, the Excel formula and the
 * stored row cannot each round a different way. A `base_per_display` of zero is impossible in the
 * database, but it is guarded anyway rather than thrown, because a planner that renders a base-unit
 * figure is readable and one that renders a 500 is not.
 */
function display(micro: bigint, basePerDisplay: bigint): string {
  if (basePerDisplay <= BigInt(0)) return formatQty(micro);
  return toDisplayQty(micro, basePerDisplay).text;
}

/** The inverse, for a figure the engine produced in display units and the database stores in base. */
function toBaseText(displayText: string, basePerDisplay: bigint): string {
  if (basePerDisplay <= BigInt(0)) return displayText;
  return formatQty(fromDisplayQty(parseQty(displayText, "qty"), basePerDisplay));
}

export function computePlan(data: ProductionPlanningData, body: PlanRequestInput): PlanResult {
  const { product, mode, requestedQty, sampleUnits, overridePct, willSendByMaterialId } = parsePlanRequest(body, data);

  const run = resolveRunGeometry(product.geometry, { mode, requestedQty, sampleUnits });
  const compositions = data.compositionsByProductId.get(product.id) ?? [];
  const compositionByMaterialId = new Map(compositions.map((row) => [row.materialId, row]));
  const factoryLocationId = data.locations.find((location) => location.isFactory)?.id ?? null;

  const stockByMaterialId = new Map<string, Map<string, bigint>>();
  for (const row of data.stock) {
    const byLocation = stockByMaterialId.get(row.materialId) ?? new Map<string, bigint>();
    byLocation.set(row.locationId, row.qty);
    stockByMaterialId.set(row.materialId, byLocation);
  }
  const priceByMaterialId = new Map(data.prices.map((row) => [row.materialId, row]));

  const requirements: MaterialRequirement[] = [];
  const inputsByMaterialId = new Map<string, MaterialRequirementInput>();
  for (const material of data.materials) {
    const composition = compositionByMaterialId.get(material.id) ?? null;
    const learned = data.learning.get(material.id);
    const overage =
      overridePct !== null
        ? { pctScaled: overridePct, source: "material" as OverageSource }
        : resolveOverage(composition?.overagePct ?? null, learned, data.settings.defaultOveragePct);

    const input: MaterialRequirementInput = {
      materialId: material.id,
      code: material.code,
      nameAr: material.nameAr,
      nameEn: material.nameEn,
      unitKind: material.unitKind,
      displayUnit: material.displayUnit,
      basePerDisplayMicro: material.basePerDisplay,
      isImported: material.isImported,
      leadTimeDays: material.leadTimeDays,
      minOrderQty: material.minOrderQty,
      purchaseIncrement: material.purchaseIncrement,
      basis: composition?.basis ?? null,
      qtyPerBasis: composition?.qtyPerBasis ?? null,
      supplier: composition?.supplier ?? null,
      overagePctScaled: overage.pctScaled,
      overageSource: overage.source,
      heldByLocationId: stockByMaterialId.get(material.id) ?? new Map(),
      factoryLocationId,
      willSendQty: willSendByMaterialId.get(material.id) ?? null,
    };
    inputsByMaterialId.set(material.id, input);
    requirements.push(resolveMaterialRequirement(input, run));
  }

  const sorted = sortRequirements(requirements);
  const summary = summariseRequirements(requirements);

  const costed: { cost: LineCost | null; contributesToBuyList: boolean }[] = [];
  const rows: PlanResultRow[] = sorted.map((row) => {
    const material = data.materials.find((candidate) => candidate.id === row.materialId)!;
    const price = priceByMaterialId.get(row.materialId) ?? null;
    // Cost what he has to BUY, not what the run consumes: he already owns the rest.
    const cost =
      price && row.contributesToBuyList && row.toBuyQty > BigInt(0)
        ? costQuantity(
            row.toBuyQty,
            material.basePerDisplay,
            {
              currency: price.currency,
              pricePerDisplayUnit: price.pricePerDisplayUnit,
              effectiveFrom: price.effectiveFrom,
            },
            data.fx,
          )
        : null;
    costed.push({ cost, contributesToBuyList: row.contributesToBuyList && row.toBuyQty > BigInt(0) });

    return {
      materialId: row.materialId,
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      unitKind: row.unitKind,
      displayUnit: row.displayUnit,
      supplier: row.supplier,
      basis: row.basis,
      overagePct: formatOveragePct(row.overagePctScaled),
      overageSource: row.overageSource,
      isImported: row.isImported,
      leadTimeDays: row.leadTimeDays,
      basisCount: row.basisCount.toString(),
      rawNeeded: display(row.rawNeededQty, material.basePerDisplay),
      needed: display(row.neededQty, material.basePerDisplay),
      neededPerRun: display(row.neededPerRunQty, material.basePerDisplay),
      heldAtFactory: display(row.heldAtFactoryQty, material.basePerDisplay),
      heldElsewhere: display(row.heldElsewhereQty, material.basePerDisplay),
      heldTotal: display(row.heldTotalQty, material.basePerDisplay),
      toBuy: display(row.toBuyQty, material.basePerDisplay),
      minToDeliver: display(row.minToDeliverQty, material.basePerDisplay),
      willSend: display(row.willSendQty, material.basePerDisplay),
      balanceAfter: display(row.balanceAfterQty, material.basePerDisplay),
      balanceAfterRuns: row.balanceAfterRunsMicro === null ? null : formatExactRuns(row.balanceAfterRunsMicro),
      coverRuns: row.coverRunsMicro === null ? null : formatExactRuns(row.coverRunsMicro),
      contributesToBuyList: row.contributesToBuyList,
      excludedReason: row.excludedReason,
      priceCurrency: price?.currency ?? null,
      pricePerDisplayUnit: price ? formatQty(price.pricePerDisplayUnit) : null,
      costUsd: cost?.usdScaled === null || cost === null ? null : formatMoney(cost.usdScaled),
      costEgp: cost?.egpScaled === null || cost === null ? null : formatMoney(cost.egpScaled),
      costDerivedMissing: cost?.derivedMissing ?? false,
    };
  });

  const costTotals = totalCosts(costed);
  const litres = (ml: bigint) => formatQty((ml * QTY_SCALE) / BigInt(1000));

  // Grouped Latin digits, built here rather than in the component, so the sentence under the tiles
  // and the workbook's own header line read identically.
  const sentence = buildPlannerSentence({
    runs: formatNumberLatin(run.runs),
    runVolumeLitres: formatNumberLatin(litres(product.geometry.runVolumeMl)),
    totalVolumeLitres: formatNumberLatin(litres(run.totalVolumeMl)),
    goodUnits: formatNumberLatin(run.goodUnits),
    goodUnitMl: formatNumberLatin(product.geometry.goodUnitMl),
    sampleUnits: formatNumberLatin(run.sampleUnits),
    sampleUnitMl: formatNumberLatin(product.geometry.sampleUnitMl),
    surplusBoxes: formatNumberLatin(run.surplusBoxes),
    shortfallBoxes: null,
  });

  return {
    productId: product.id,
    productNameAr: product.nameAr,
    mode,
    requestedQty: requestedQty.toString(),
    sampleUnits: sampleUnits.toString(),
    runs: run.runs.toString(),
    exactRuns: formatExactRuns(run.exactRunsMicro),
    rounded: run.rounded,
    goodUnits: run.goodUnits.toString(),
    packagingSets: run.packagingSets.toString(),
    totalBoxes: run.totalBoxes.toString(),
    requestedBoxes: run.requestedBoxes.toString(),
    surplusBoxes: run.surplusBoxes.toString(),
    totalVolumeMl: run.totalVolumeMl.toString(),
    totalVolumeLitres: litres(run.totalVolumeMl),
    runVolumeLitres: litres(product.geometry.runVolumeMl),
    totalDoses: run.totalDoses.toString(),
    leftoverMl: run.leftoverMl.toString(),
    oneRunFewer: run.oneRunFewer
      ? {
          runs: run.oneRunFewer.runs.toString(),
          totalBoxes: run.oneRunFewer.totalBoxes.toString(),
          shortfallBoxes: run.oneRunFewer.shortfallBoxes.toString(),
        }
      : null,
    sentence,
    rows,
    totals: {
      materials: summary.materials,
      toBuyCount: summary.toBuyCount,
      unsettled: summary.unsettled,
      factorySupplied: summary.factorySupplied,
      withoutComposition: summary.withoutComposition,
      shortAfterRunCount: summary.shortAfterRunCount,
      costUsd: formatMoney(costTotals.usdScaled),
      costEgp: formatMoney(costTotals.egpScaled),
      unpricedMaterials: costTotals.unpricedMaterials,
      incompleteMaterials: costTotals.incompleteMaterials,
      fxRate: data.fx.usdToEgpMicro === null ? null : formatQty(data.fx.usdToEgpMicro),
      fxSource: data.fx.source,
      fxRateDate: data.fx.rateDate,
    },
  };
}

/** Recorded runs, newest first, with their per-material actuals beside their own theory. */
export async function listRuns(access: AccessContext) {
  const level = await resolveProductionPlanningLevel(access);
  assertProductionPlanningRead(access, level);
  const db = getSupabaseAdmin();
  const [runsRes, linesRes] = await Promise.all([
    db.from(T.runs).select(RUN_COLUMNS).order("produced_on", { ascending: false }).limit(60),
    db.from(T.runMaterials).select(RUN_MATERIAL_COLUMNS),
  ]);
  if (runsRes.error) failure(runsRes.error, "load the recorded runs");
  if (linesRes.error) failure(linesRes.error, "load the runs' materials");

  const linesByRunId = new Map<string, WireRun["materials"]>();
  for (const row of linesRes.data ?? []) {
    const runId = String(row.run_id);
    const list = linesByRunId.get(runId) ?? [];
    list.push({
      materialId: String(row.material_id),
      openingQty: String(row.opening_qty ?? "0"),
      deliveredQty: String(row.delivered_qty ?? "0"),
      closingQty: String(row.closing_qty ?? "0"),
      // The generated column, so this is the database's own subtraction and not a repeat of it here.
      consumedQty: String(row.consumed_qty ?? "0"),
      theoreticalQty: asText(row.theoretical_qty),
      note: asText(row.note),
    });
    linesByRunId.set(runId, list);
  }

  return (runsRes.data ?? []).map((row) => ({
    id: String(row.id),
    productId: String(row.product_id),
    planId: asText(row.plan_id),
    runLabel: String(row.run_label),
    runsCount: String(row.runs_count ?? 1),
    actualGoodUnits: String(row.actual_good_units ?? "0"),
    actualSampleUnits: String(row.actual_sample_units ?? "0"),
    producedOn: String(row.produced_on),
    isExcludedFromLearning: row.is_excluded_from_learning === true,
    exclusionReason: asText(row.exclusion_reason),
    notes: asText(row.notes),
    recordedByLogin: asText(row.recorded_by_login),
    materials: linesByRunId.get(String(row.id)) ?? [],
  }));
}

/** Saved plans, newest first. A draft carries no lines; a committed one carries its whole snapshot. */
export async function listPlans(access: AccessContext) {
  const level = await resolveProductionPlanningLevel(access);
  assertProductionPlanningRead(access, level);
  const { data, error } = await getSupabaseAdmin()
    .from(T.plans)
    .select(PLAN_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) failure(error, "load the saved plans");
  return (data ?? []).map((row) => ({
    id: String(row.id),
    productId: String(row.product_id),
    title: String(row.title),
    requestMode: String(row.request_mode),
    requestedQty: String(row.requested_qty),
    sampleUnits: String(row.sample_units ?? "0"),
    status: String(row.status),
    runs: row.snap_runs === null || row.snap_runs === undefined ? null : String(row.snap_runs),
    goodUnits: row.snap_good_units === null || row.snap_good_units === undefined ? null : String(row.snap_good_units),
    packagingSets:
      row.snap_packaging_sets === null || row.snap_packaging_sets === undefined
        ? null
        : String(row.snap_packaging_sets),
    overagePct: asText(row.snap_overage_pct),
    fxUsdToEgp: asText(row.snap_fx_usd_to_egp),
    fxRateDate: asText(row.snap_fx_rate_date),
    notes: asText(row.notes),
    createdByLogin: asText(row.created_by_login),
    committedAt: asText(row.committed_at),
    committedByLogin: asText(row.committed_by_login),
    createdAt: asText(row.created_at),
  }));
}

// ── The whole workspace payload ────────────────────────────────────────────────────────────────────

/**
 * One GET for the whole screen, so the five tabs do not each fetch their own half of the same data
 * and then disagree about it.
 */
/**
 * The return type is ANNOTATED, not inferred, and that is load-bearing: the workspace is read by the
 * client component AND by the workbook builder, both of which import `WireWorkspace` and neither of
 * which can see this file. Without the annotation a field renamed here would typecheck everywhere and
 * arrive as `undefined` at the screen.
 */
export async function getProductionPlanningWorkspace(
  access: AccessContext,
  body: PlanRequestInput = {},
): Promise<WireWorkspace> {
  const data = await loadProductionPlanningData(access);
  // 🔴 A BARE READ MUST NOT 400. `parsePlanRequest` requires `requestedQty >= 1`, which is right for
  // a plan the screen asked for and wrong for the first load: the workspace GET answers the whole
  // screen, and a request with no query string was answering
  // `{"message":"A count below 1 is not allowed here.","field":"requestedQty"}` — so the module
  // opened on its own error message for every one of the five people who can see it, with every
  // figure in it correct. Measured against the running app on 2026-10-06. No quantity asked for means
  // no plan computed, never a refusal to load.
  const askedForAPlan = asScalar(body.requestedQty) !== null;
  const plan = data.products.length > 0 && askedForAPlan ? computePlan(data, body) : null;
  const [runs, plans] = await Promise.all([listRuns(access), listPlans(access)]);

  return {
    level: data.level,
    canWrite: data.level === "full",
    products: data.products.map((product) => ({
      id: product.id,
      code: product.code,
      nameAr: product.nameAr,
      nameEn: product.nameEn,
      manufacturerName: product.manufacturerName,
      runVolumeMl: product.geometry.runVolumeMl.toString(),
      doseMl: product.geometry.doseMl.toString(),
      goodUnitMl: product.geometry.goodUnitMl.toString(),
      sampleUnitMl: product.geometry.sampleUnitMl.toString(),
      wholeRunsOnly: product.geometry.wholeRunsOnly,
      unitsPerBox: product.geometry.unitsPerBox.toString(),
      notes: product.notes,
    })),
    locations: data.locations,
    materials: data.materials.map((material) => {
      const composition = (data.compositionsByProductId.get(data.products[0]?.id ?? "") ?? []).find(
        (row) => row.materialId === material.id,
      );
      const learned = data.learning.get(material.id);
      const price = data.prices.find((row) => row.materialId === material.id) ?? null;
      return {
        id: material.id,
        code: material.code,
        nameAr: material.nameAr,
        nameEn: material.nameEn,
        unitKind: material.unitKind,
        baseUnit: material.baseUnit,
        displayUnit: material.displayUnit,
        basePerDisplay: formatQty(material.basePerDisplay),
        isImported: material.isImported,
        leadTimeDays: material.leadTimeDays,
        minOrderQty: material.minOrderQty === null ? null : formatQty(material.minOrderQty),
        purchaseIncrement: material.purchaseIncrement === null ? null : formatQty(material.purchaseIncrement),
        reorderCoverRuns: material.reorderCoverRuns === null ? null : formatQty(material.reorderCoverRuns),
        notes: material.notes,
        composition: composition
          ? {
              basis: composition.basis,
              qtyPerBasis: formatQty(composition.qtyPerBasis),
              supplier: composition.supplier,
              overagePct: composition.overagePct === null ? null : formatPct(composition.overagePct),
              effectiveFrom: composition.effectiveFrom,
              notes: composition.notes,
            }
          : null,
        stock: data.stock
          .filter((row) => row.materialId === material.id)
          .map((row) => ({
            locationId: row.locationId,
            qty: formatQty(row.qty),
            qtyDisplay: display(row.qty, material.basePerDisplay),
            asOfDate: row.asOfDate,
            source: row.source,
            note: row.note,
          })),
        price: price
          ? {
              currency: price.currency,
              pricePerDisplayUnit: formatQty(price.pricePerDisplayUnit),
              effectiveFrom: price.effectiveFrom,
              supplierName: price.supplierName,
            }
          : null,
        learning: learned
          ? {
              runsCounted: learned.runsCounted.toString(),
              consumedTotal: formatQty(learned.consumedTotalQty),
              theoreticalTotal: formatQty(learned.theoreticalTotalQty),
              impliedOveragePct:
                learned.impliedOveragePctScaled === null ? null : formatOveragePct(learned.impliedOveragePctScaled),
              recommendedOveragePct:
                learned.recommendedOveragePctScaled === null
                  ? null
                  : formatOveragePct(learned.recommendedOveragePctScaled),
              withheldReason: learned.withheldReason,
            }
          : null,
      };
    }),
    settings: {
      defaultOveragePct: formatPct(data.settings.defaultOveragePct),
      reorderCoverRuns: formatQty(data.settings.reorderCoverRuns),
      alarmEnabled: data.settings.alarmEnabled,
      alarmDryRun: data.settings.alarmDryRun,
      fxFetchEnabled: data.settings.fxFetchEnabled,
      fxFetchDryRun: data.settings.fxFetchDryRun,
      fxFallbackUsdToEgp:
        data.settings.fxFallbackUsdToEgp === null ? null : formatQty(data.settings.fxFallbackUsdToEgp),
      alarmLastEvaluatedOn: data.settings.alarmLastEvaluatedOn,
      alarmLastSentOn: data.settings.alarmLastSentOn,
      updatedByLogin: data.settings.updatedByLogin,
      updatedAt: data.settings.updatedAt,
    },
    fx: {
      rate: data.fx.usdToEgpMicro === null ? null : formatQty(data.fx.usdToEgpMicro),
      rateDate: data.fx.rateDate,
      source: data.fx.source,
    },
    plan,
    runs,
    plans,
  };
}

// ── Writes ─────────────────────────────────────────────────────────────────────────────────────────

async function assertWrite(access: AccessContext): Promise<ProductionPlanningLevel> {
  const level = await resolveProductionPlanningLevel(access);
  assertProductionPlanningWrite(access, level);
  return level;
}

/** Append a stock report. Nothing is ever overwritten — the newest row IS the current figure. */
export async function addStockEntry(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const materialId = asText(body.materialId);
  const locationId = asText(body.locationId);
  if (!materialId || !locationId) {
    throw new ProductionPlanningInputError("المادة والموقع مطلوبان.", "materialId");
  }
  const unitKind = UNIT_KINDS.find((candidate) => candidate === body.unitKind);
  if (!unitKind) throw new ProductionPlanningInputError("نوع الوحدة غير معروف.", "unitKind");
  const qty = parseNonNegativeQty(asScalar(body.qty), "qty");
  const asOfDate = asText(body.asOfDate) ?? todayCairo();
  const source = asText(body.source) ?? "factory_report";

  const { data, error } = await getSupabaseAdmin()
    .from(T.stock)
    .insert({
      material_id: materialId,
      unit_kind: unitKind,
      location_id: locationId,
      qty: formatQty(qty),
      as_of_date: asOfDate,
      source,
      note: asText(body.note),
      recorded_by_hr_id: who.hrId,
      recorded_by_login: who.login,
    })
    .select("id")
    .maybeSingle();
  if (error) failure(error, "record the stock report");

  await writeAuditLog({
    actorLoginId: who.login,
    entityType: "production_stock_entry",
    entityId: data?.id ? String(data.id) : null,
    newValues: { materialId, locationId, qty: formatQty(qty), asOfDate, source },
    summary: `Production planner: stock report for material ${materialId} at ${locationId} — ${formatQty(qty)} as of ${asOfDate}`,
  });

  return { id: data?.id ? String(data.id) : null };
}

/**
 * Append a price, in ONE currency, exactly as typed.
 *
 * `writeRequiredAuditLog`, not the ordinary one: an unrecorded price change is how an order cost
 * moves with nobody able to say who moved it. If the trail cannot be written, the price change fails.
 */
export async function addMaterialPrice(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const materialId = asText(body.materialId);
  if (!materialId) throw new ProductionPlanningInputError("المادة مطلوبة.", "materialId");
  const unitKind = UNIT_KINDS.find((candidate) => candidate === body.unitKind);
  if (!unitKind) throw new ProductionPlanningInputError("نوع الوحدة غير معروف.", "unitKind");
  const currency: Currency | undefined = body.currency === "USD" ? "USD" : body.currency === "EGP" ? "EGP" : undefined;
  if (!currency) throw new ProductionPlanningInputError("العملة غير معروفة.", "currency");
  const price = parseNonNegativeQty(asScalar(body.pricePerDisplayUnit), "pricePerDisplayUnit");
  if (price <= BigInt(0)) throw new ProductionPlanningInputError("السعر يجب أن يكون أكبر من صفر.", "pricePerDisplayUnit");
  const effectiveFrom = asText(body.effectiveFrom) ?? todayCairo();

  const db = getSupabaseAdmin();
  // Read the previous price BEFORE the write, so oldValues on the trail is real rather than a guess.
  const previous = await db
    .from(T.prices)
    .select(PRICE_COLUMNS)
    .eq("material_id", materialId)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await db
    .from(T.prices)
    .upsert(
      {
        material_id: materialId,
        unit_kind: unitKind,
        currency,
        price_per_display_unit: formatQty(price),
        effective_from: effectiveFrom,
        supplier_name: asText(body.supplierName),
        note: asText(body.note),
        recorded_by_hr_id: who.hrId,
        recorded_by_login: who.login,
      },
      { onConflict: "material_id,currency,effective_from" },
    )
    .select("id")
    .maybeSingle();
  if (error) failure(error, "record the price");

  await writeRequiredAuditLog({
    actorLoginId: who.login,
    entityType: "production_material_price",
    entityId: data?.id ? String(data.id) : materialId,
    oldValues: previous.data
      ? {
          currency: previous.data.currency,
          pricePerDisplayUnit: previous.data.price_per_display_unit,
          effectiveFrom: previous.data.effective_from,
        }
      : null,
    newValues: { currency, pricePerDisplayUnit: formatQty(price), effectiveFrom },
    summary: `Production planner: price for material ${materialId} set to ${formatQty(price)} ${currency} per display unit, effective ${effectiveFrom}`,
  });

  return { id: data?.id ? String(data.id) : null };
}

/** Record a finished run and its per-material actuals. This is what makes the overage measured. */
export async function recordRun(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const data = await loadProductionPlanningData(access);

  const productId = asText(body.productId) ?? data.products[0]?.id ?? null;
  const product = data.products.find((candidate) => candidate.id === productId);
  if (!product) throw new ProductionPlanningInputError("المنتج غير موجود.", "productId");

  const runLabel = asText(body.runLabel);
  if (!runLabel) throw new ProductionPlanningInputError("اسم التشغيلة مطلوب.", "runLabel");
  const runsCount = parseWholeCount(asScalar(body.runsCount) ?? 1, "runsCount", { min: BigInt(1), max: BigInt(1000) });
  const actualGoodUnits = parseWholeCount(asScalar(body.actualGoodUnits) ?? 0, "actualGoodUnits", { min: BigInt(0) });
  const actualSampleUnits = parseWholeCount(asScalar(body.actualSampleUnits) ?? 0, "actualSampleUnits", { min: BigInt(0) });
  const producedOn = asText(body.producedOn) ?? todayCairo();
  const isExcluded = body.isExcludedFromLearning === true;
  const exclusionReason = asText(body.exclusionReason);
  if (isExcluded && !exclusionReason) {
    throw new ProductionPlanningInputError("سبب الاستثناء مطلوب.", "exclusionReason");
  }

  // The theory this run is compared against, computed from the geometry it actually ran at.
  const theory = computePlan(data, {
    productId: product.id,
    mode: "runs",
    requestedQty: runsCount.toString(),
    sampleUnits: actualSampleUnits.toString(),
  });
  const theoryByMaterialId = new Map(theory.rows.map((row) => [row.materialId, row]));

  const db = getSupabaseAdmin();
  const { data: inserted, error } = await db
    .from(T.runs)
    .insert({
      product_id: product.id,
      plan_id: asText(body.planId),
      run_label: runLabel,
      runs_count: Number(runsCount),
      actual_good_units: actualGoodUnits.toString(),
      actual_sample_units: actualSampleUnits.toString(),
      snap_run_volume_ml: product.geometry.runVolumeMl.toString(),
      snap_dose_ml: Number(product.geometry.doseMl),
      snap_good_unit_ml: Number(product.geometry.goodUnitMl),
      snap_sample_unit_ml: Number(product.geometry.sampleUnitMl),
      produced_on: producedOn,
      is_excluded_from_learning: isExcluded,
      exclusion_reason: exclusionReason,
      notes: asText(body.notes),
      recorded_by_hr_id: who.hrId,
      recorded_by_login: who.login,
    })
    .select("id")
    .maybeSingle();
  if (error) failure(error, "record the run");
  const runId = inserted?.id ? String(inserted.id) : null;
  if (!runId) failure(null, "record the run");

  const lines = Array.isArray(body.materials) ? (body.materials as Record<string, unknown>[]) : [];
  const rows = lines.map((line) => {
    const materialId = asText(line.materialId);
    if (!materialId) throw new ProductionPlanningInputError("مادة بدون معرِّف في أحد السطور.", "materials");
    const material = data.materials.find((candidate) => candidate.id === materialId);
    if (!material) throw new ProductionPlanningInputError("مادة غير موجودة في أحد السطور.", "materials");
    const opening = parseNonNegativeQty(asScalar(line.openingQty) ?? "0", "openingQty");
    const delivered = parseNonNegativeQty(asScalar(line.deliveredQty) ?? "0", "deliveredQty");
    const closing = parseNonNegativeQty(asScalar(line.closingQty) ?? "0", "closingQty");
    if (closing > opening + delivered) {
      throw new ProductionPlanningInputError(
        `${material.nameAr}: رصيد آخر المدة أكبر من رصيد أول المدة زائد المُسلَّم.`,
        "closingQty",
      );
    }
    const predicted = theoryByMaterialId.get(materialId)?.needed ?? null;
    return {
      run_id: runId,
      material_id: materialId,
      unit_kind: material.unitKind,
      opening_qty: formatQty(opening),
      delivered_qty: formatQty(delivered),
      closing_qty: formatQty(closing),
      // Stored in BASE units, like every other quantity; `needed` on the row is a display figure.
      theoretical_qty: predicted === null ? null : toBaseText(predicted, material.basePerDisplay),
      note: asText(line.note),
    };
  });

  if (rows.length > 0) {
    const { error: linesError } = await db.from(T.runMaterials).insert(rows);
    if (linesError) failure(linesError, "record the run's materials");
  }

  await writeRequiredAuditLog({
    actorLoginId: who.login,
    entityType: "production_run",
    entityId: runId,
    newValues: {
      productCode: product.code,
      runLabel,
      runsCount: runsCount.toString(),
      actualGoodUnits: actualGoodUnits.toString(),
      actualSampleUnits: actualSampleUnits.toString(),
      producedOn,
      materials: rows.length,
      isExcludedFromLearning: isExcluded,
    },
    summary: `Production planner: recorded run "${runLabel}" of ${product.code} — ${runsCount} run(s), ${actualGoodUnits} units, ${rows.length} material line(s)${isExcluded ? " (excluded from learning)" : ""}`,
  });

  return { id: runId, materialLines: rows.length };
}

/** The settings singleton, including the four arming flags. */
export async function updateSettings(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const db = getSupabaseAdmin();

  const previous = await db.from(T.settings).select(SETTINGS_COLUMNS).eq("id", 1).maybeSingle();

  const patch: Record<string, unknown> = { id: 1, updated_by_hr_id: who.hrId, updated_by_login: who.login, updated_at: new Date().toISOString() };
  if (asText(body.defaultOveragePct) !== null) {
    patch.default_overage_pct = formatPct(parsePct(String(body.defaultOveragePct), "defaultOveragePct"));
  }
  if (asText(body.reorderCoverRuns) !== null) {
    patch.reorder_cover_runs = formatQty(parseNonNegativeQty(asScalar(body.reorderCoverRuns), "reorderCoverRuns"));
  }
  // Arming is only ever an explicit boolean. Anything else leaves the flag where it was, so a typo
  // in a payload cannot switch the email on.
  if (typeof body.alarmEnabled === "boolean") patch.alarm_enabled = body.alarmEnabled;
  if (typeof body.alarmDryRun === "boolean") patch.alarm_dry_run = body.alarmDryRun;
  if (typeof body.fxFetchEnabled === "boolean") patch.fx_fetch_enabled = body.fxFetchEnabled;
  if (typeof body.fxFetchDryRun === "boolean") patch.fx_fetch_dry_run = body.fxFetchDryRun;
  if (asText(body.fxFallbackUsdToEgp) !== null) {
    patch.fx_fallback_usd_to_egp = formatQty(parseNonNegativeQty(asScalar(body.fxFallbackUsdToEgp), "fxFallbackUsdToEgp"));
  }

  const { error } = await db.from(T.settings).upsert(patch, { onConflict: "id" });
  if (error) failure(error, "save the settings");

  const armingChanged =
    (typeof body.alarmEnabled === "boolean" && body.alarmEnabled !== (previous.data?.alarm_enabled === true)) ||
    (typeof body.alarmDryRun === "boolean" && body.alarmDryRun !== (previous.data?.alarm_dry_run !== false));

  // Arming the email is REQUIRED on the trail: it is the moment this module starts speaking to
  // people outside it. Everything else here is a reversible threshold.
  const write = armingChanged ? writeRequiredAuditLog : writeAuditLog;
  await write({
    actorLoginId: who.login,
    entityType: "production_planning_settings",
    entityId: "1",
    oldValues: previous.data
      ? {
          defaultOveragePct: previous.data.default_overage_pct,
          reorderCoverRuns: previous.data.reorder_cover_runs,
          alarmEnabled: previous.data.alarm_enabled,
          alarmDryRun: previous.data.alarm_dry_run,
          fxFetchEnabled: previous.data.fx_fetch_enabled,
          fxFetchDryRun: previous.data.fx_fetch_dry_run,
        }
      : null,
    newValues: patch,
    summary: armingChanged
      ? `Production planner: reorder email arming changed — enabled=${patch.alarm_enabled ?? previous.data?.alarm_enabled}, dryRun=${patch.alarm_dry_run ?? previous.data?.alarm_dry_run}`
      : "Production planner: settings updated",
  });

  return { ok: true };
}

/** A manual USD→EGP rate for one date, which beats whatever the fetch found. */
export async function setManualFxRate(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const rateDate = asText(body.rateDate) ?? todayCairo();
  const rate = parseNonNegativeQty(asScalar(body.usdToEgp), "usdToEgp");
  if (rate <= BigInt(0)) throw new ProductionPlanningInputError("سعر الصرف يجب أن يكون أكبر من صفر.", "usdToEgp");

  const { error } = await getSupabaseAdmin()
    .from(T.fx)
    .upsert(
      {
        rate_date: rateDate,
        manual_usd_to_egp: formatQty(rate),
        manual_note: asText(body.note),
        manual_by_hr_id: who.hrId,
        manual_by_login: who.login,
        manual_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "rate_date" },
    );
  if (error) failure(error, "save the exchange rate");

  await writeAuditLog({
    actorLoginId: who.login,
    entityType: "production_planning_settings",
    entityId: rateDate,
    newValues: { rateDate, manualUsdToEgp: formatQty(rate) },
    summary: `Production planner: manual USD to EGP rate for ${rateDate} set to ${formatQty(rate)}`,
  });

  return { ok: true };
}

/** A material's own fields, and its line in the formula. The formula is versioned, never edited. */
export async function saveMaterialAndComposition(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const db = getSupabaseAdmin();
  const materialId = asText(body.materialId);
  if (!materialId) throw new ProductionPlanningInputError("المادة مطلوبة.", "materialId");

  const previous = await db.from(T.materials).select(MATERIAL_COLUMNS).eq("id", materialId).maybeSingle();
  if (!previous.data) throw new ProductionPlanningInputError("المادة غير موجودة.", "materialId");

  const materialPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.isImported === "boolean") materialPatch.is_imported = body.isImported;
  if (body.leadTimeDays === null || typeof body.leadTimeDays === "number") materialPatch.lead_time_days = body.leadTimeDays;
  if ("minOrderQty" in body) {
    materialPatch.min_order_qty = asText(body.minOrderQty) === null ? null : formatQty(parseNonNegativeQty(asScalar(body.minOrderQty), "minOrderQty"));
  }
  if ("purchaseIncrement" in body) {
    materialPatch.purchase_increment =
      asText(body.purchaseIncrement) === null ? null : formatQty(parseNonNegativeQty(asScalar(body.purchaseIncrement), "purchaseIncrement"));
  }
  if ("reorderCoverRuns" in body) {
    materialPatch.reorder_cover_runs =
      asText(body.reorderCoverRuns) === null ? null : formatQty(parseNonNegativeQty(asScalar(body.reorderCoverRuns), "reorderCoverRuns"));
  }
  if (asText(body.notes) !== null) materialPatch.notes = asText(body.notes);

  if (Object.keys(materialPatch).length > 1) {
    const { error } = await db.from(T.materials).update(materialPatch).eq("id", materialId);
    if (error) failure(error, "save the material");
  }

  // The composition is versioned: a change CLOSES the row in force and OPENS a new one, so a plan
  // committed last month still reproduces with the formula it was committed under.
  let compositionId: string | null = null;
  const productId = asText(body.productId);
  if (productId && asText(body.qtyPerBasis) !== null) {
    const basis = COMPOSITION_BASES.find((candidate) => candidate === body.basis);
    const supplier = MATERIAL_SUPPLIERS.find((candidate) => candidate === body.supplier);
    if (!basis) throw new ProductionPlanningInputError("أساس الحساب غير معروف.", "basis");
    if (!supplier) throw new ProductionPlanningInputError("مورد المادة غير معروف.", "supplier");
    const qtyPerBasis = parseNonNegativeQty(asScalar(body.qtyPerBasis), "qtyPerBasis");
    if (qtyPerBasis <= BigInt(0)) throw new ProductionPlanningInputError("الكمية يجب أن تكون أكبر من صفر.", "qtyPerBasis");
    const effectiveFrom = asText(body.effectiveFrom) ?? todayCairo();

    const { error: closeError } = await db
      .from(T.compositions)
      .update({ effective_to: effectiveFrom, updated_at: new Date().toISOString() })
      .eq("product_id", productId)
      .eq("material_id", materialId)
      .is("effective_to", null)
      .lt("effective_from", effectiveFrom);
    if (closeError) failure(closeError, "close the previous formula row");

    const { data: openedRow, error: openError } = await db
      .from(T.compositions)
      .upsert(
        {
          product_id: productId,
          material_id: materialId,
          unit_kind: previous.data.unit_kind,
          basis,
          qty_per_basis: formatQty(qtyPerBasis),
          supplier,
          overage_pct: asText(body.overagePct) === null ? null : formatPct(parsePct(String(body.overagePct), "overagePct")),
          effective_from: effectiveFrom,
          notes: asText(body.compositionNotes),
          created_by_hr_id: who.hrId,
          created_by_login: who.login,
        },
        { onConflict: "product_id,material_id,effective_from" },
      )
      .select("id")
      .maybeSingle();
    if (openError) failure(openError, "save the formula");
    compositionId = openedRow?.id ? String(openedRow.id) : null;
  }

  await writeAuditLog({
    actorLoginId: who.login,
    entityType: "production_material",
    entityId: materialId,
    oldValues: {
      isImported: previous.data.is_imported,
      leadTimeDays: previous.data.lead_time_days,
      minOrderQty: previous.data.min_order_qty,
      purchaseIncrement: previous.data.purchase_increment,
      reorderCoverRuns: previous.data.reorder_cover_runs,
    },
    newValues: { ...materialPatch, compositionId },
    summary: `Production planner: material ${previous.data.code} updated${compositionId ? " with a new formula row" : ""}`,
  });

  return { materialId, compositionId };
}

/** Save a plan as a draft, or commit it with its whole snapshot. */
export async function savePlan(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const data = await loadProductionPlanningData(access);
  const result = computePlan(data, body as PlanRequestInput);
  const commit = body.commit === true;

  const unsettledInBuyList = result.rows.filter(
    (row) => row.excludedReason === "supplier_unsettled" && row.needed !== "0",
  );
  if (commit && unsettledInBuyList.length > 0) {
    // The database refuses `shared_unsettled` on a committed line, so catch it here with a sentence
    // somebody can act on rather than letting a constraint produce a 500.
    throw new ProductionPlanningInputError(
      `لا يمكن اعتماد الخطة قبل تحديد من يورد: ${unsettledInBuyList.map((row) => row.nameAr).join("، ")}`,
      "supplier",
    );
  }

  const title = asText(body.title) ?? `${result.productNameAr} — ${result.runs} ${PP.unitRuns}`;
  const db = getSupabaseAdmin();
  const product = data.products.find((candidate) => candidate.id === result.productId)!;

  const planRow: Record<string, unknown> = {
    product_id: result.productId,
    title,
    request_mode: result.mode,
    requested_qty: result.requestedQty,
    sample_units: result.sampleUnits,
    status: commit ? "committed" : "draft",
    notes: asText(body.notes),
    created_by_hr_id: who.hrId,
    created_by_login: who.login,
    updated_at: new Date().toISOString(),
  };
  if (commit) {
    Object.assign(planRow, {
      snap_overage_pct: formatPct(data.settings.defaultOveragePct),
      snap_run_volume_ml: product.geometry.runVolumeMl.toString(),
      snap_dose_ml: Number(product.geometry.doseMl),
      snap_good_unit_ml: Number(product.geometry.goodUnitMl),
      snap_sample_unit_ml: Number(product.geometry.sampleUnitMl),
      snap_units_per_box: Number(product.geometry.unitsPerBox),
      snap_runs: result.runs,
      snap_good_units: result.goodUnits,
      snap_packaging_sets: result.packagingSets,
      snap_fx_usd_to_egp: result.totals.fxRate,
      snap_fx_rate_date: result.totals.fxRateDate,
      committed_at: new Date().toISOString(),
      committed_by_hr_id: who.hrId,
      committed_by_login: who.login,
    });
  }

  const { data: inserted, error } = await db.from(T.plans).insert(planRow).select("id").maybeSingle();
  if (error) failure(error, "save the plan");
  const planId = inserted?.id ? String(inserted.id) : null;
  if (!planId) failure(null, "save the plan");

  // Lines are MATERIALISED only on commit. A draft recomputes live, so there is never a stored line
  // that quietly disagrees with the current formula or the current stock.
  if (commit) {
    const lineRows = result.rows
      .filter((row) => row.supplier === "sato" || row.supplier === "factory")
      .map((row) => {
        const material = data.materials.find((candidate) => candidate.id === row.materialId)!;
        const toBase = (text: string) => toBaseText(text, material.basePerDisplay);
        return {
          plan_id: planId,
          material_id: row.materialId,
          unit_kind: row.unitKind,
          snap_supplier: row.supplier,
          snap_basis: row.basis,
          snap_qty_per_basis: formatQty(
            data.compositionsByProductId.get(result.productId)?.find((c) => c.materialId === row.materialId)
              ?.qtyPerBasis ?? BigInt(0),
          ),
          snap_overage_pct: row.overagePct,
          needed_qty: toBase(row.needed),
          held_qty: toBase(row.heldTotal),
          to_buy_qty: toBase(row.toBuy),
          to_deliver_qty: toBase(row.minToDeliver),
          balance_after_qty: toBase(row.balanceAfter),
          snap_price_currency: row.priceCurrency,
          snap_price_per_display_unit: row.pricePerDisplayUnit,
          snap_cost_usd: row.costUsd,
          snap_cost_egp: row.costEgp,
        };
      })
      .filter((row) => row.snap_basis !== null);

    if (lineRows.length > 0) {
      const { error: linesError } = await db.from(T.planLines).insert(lineRows);
      if (linesError) failure(linesError, "save the plan's lines");
    }
  }

  const write = commit ? writeRequiredAuditLog : writeAuditLog;
  await write({
    actorLoginId: who.login,
    entityType: "production_plan",
    entityId: planId,
    newValues: {
      productCode: product.code,
      title,
      mode: result.mode,
      requestedQty: result.requestedQty,
      sampleUnits: result.sampleUnits,
      runs: result.runs,
      goodUnits: result.goodUnits,
      packagingSets: result.packagingSets,
      status: commit ? "committed" : "draft",
      costUsd: result.totals.costUsd,
      costEgp: result.totals.costEgp,
    },
    summary: `Production planner: ${commit ? "COMMITTED" : "drafted"} "${title}" — ${result.runs} run(s), ${result.goodUnits} units + ${result.sampleUnits} samples`,
  });

  return { id: planId, status: commit ? "committed" : "draft", plan: result };
}

/** Add, change or remove a named grant. Full control only — this one changes who can see costs. */
export async function saveAccessGrant(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const hrId = asText(body.hrId)?.toUpperCase() ?? null;
  if (!hrId) throw new ProductionPlanningInputError("رقم الموظف مطلوب.", "hrId");
  const db = getSupabaseAdmin();
  const previous = await db.from(T.grants).select("id, hr_id, level, note").eq("hr_id", hrId).maybeSingle();

  if (body.remove === true) {
    const { error } = await db.from(T.grants).delete().eq("hr_id", hrId);
    if (error) failure(error, "remove the grant");
    await writeRequiredAuditLog({
      actorLoginId: who.login,
      entityType: "production_planning_access_grant",
      entityId: hrId,
      oldValues: previous.data ? { level: previous.data.level, note: previous.data.note } : null,
      newValues: null,
      summary: `Production planner: access removed for ${hrId}`,
    });
    return { hrId, removed: true };
  }

  const level = body.level === "full" ? "full" : body.level === "read" ? "read" : null;
  if (!level) throw new ProductionPlanningInputError("مستوى الصلاحية غير معروف.", "level");

  const { error } = await db
    .from(T.grants)
    .upsert(
      {
        hr_id: hrId,
        level,
        note: asText(body.note),
        granted_by_hr_id: who.hrId,
        granted_by_login: who.login,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "hr_id" },
    );
  if (error) failure(error, "save the grant");

  await writeRequiredAuditLog({
    actorLoginId: who.login,
    entityType: "production_planning_access_grant",
    entityId: hrId,
    oldValues: previous.data ? { level: previous.data.level, note: previous.data.note } : null,
    newValues: { level, note: asText(body.note) },
    summary: `Production planner: access for ${hrId} set to ${level}`,
  });

  return { hrId, level };
}

/** Who holds a stored grant. Full control only: it names people and what they can see. */
export async function listAccessGrants(access: AccessContext) {
  await assertWrite(access);
  const { data, error } = await getSupabaseAdmin()
    .from(T.grants)
    .select("hr_id, level, note, granted_by_login, created_at")
    .order("hr_id");
  if (error) failure(error, "load the grants");
  return (data ?? []).map((row) => ({
    hrId: String(row.hr_id),
    level: row.level === "full" ? "full" : "read",
    note: asText(row.note),
    grantedByLogin: asText(row.granted_by_login),
    createdAt: asText(row.created_at),
  }));
}

/** The reorder verdicts for one product at its baseline (no samples), used by the cron and the screen. */
export async function evaluateReorderAlarms(data: ProductionPlanningData, productId?: string) {
  const product = productId
    ? data.products.find((candidate) => candidate.id === productId)
    : data.products[0];
  if (!product) return { product: null, verdicts: [] as ReturnType<typeof evaluateAlarms> };

  const plan = computePlanInternal(data, product.id);
  const thresholdByMaterialId = new Map<string, bigint>();
  for (const material of data.materials) {
    if (material.reorderCoverRuns !== null) thresholdByMaterialId.set(material.id, material.reorderCoverRuns);
  }

  return {
    product,
    verdicts: evaluateAlarms(plan.requirements, {
      defaultThresholdRunsMicro:
        data.settings.reorderCoverRuns > BigInt(0) ? data.settings.reorderCoverRuns : thresholdRunsToMicro(BigInt(1)),
      thresholdByMaterialId,
    }),
  };
}

/**
 * One run, no samples — the BASELINE cover is read in.
 *
 * A mass is volume-driven so the sample rate does not change it, but packaging IS sample-driven, so
 * a baseline figure understates packaging for a run that carries samples. That is deliberate and
 * visible: `needed_per_run_qty` is stored on every alarm row, so the email says which figure it used
 * rather than implying a number nobody chose.
 */
function computePlanInternal(data: ProductionPlanningData, productId: string) {
  const product = data.products.find((candidate) => candidate.id === productId)!;
  const run = resolveRunGeometry(product.geometry, { mode: "runs", requestedQty: BigInt(1), sampleUnits: BigInt(0) });
  const compositions = data.compositionsByProductId.get(productId) ?? [];
  const compositionByMaterialId = new Map(compositions.map((row) => [row.materialId, row]));
  const factoryLocationId = data.locations.find((location) => location.isFactory)?.id ?? null;

  const stockByMaterialId = new Map<string, Map<string, bigint>>();
  for (const row of data.stock) {
    const byLocation = stockByMaterialId.get(row.materialId) ?? new Map<string, bigint>();
    byLocation.set(row.locationId, row.qty);
    stockByMaterialId.set(row.materialId, byLocation);
  }

  const requirements = data.materials.map((material) => {
    const composition = compositionByMaterialId.get(material.id) ?? null;
    const overage = resolveOverage(
      composition?.overagePct ?? null,
      data.learning.get(material.id),
      data.settings.defaultOveragePct,
    );
    return resolveMaterialRequirement(
      {
        materialId: material.id,
        code: material.code,
        nameAr: material.nameAr,
        nameEn: material.nameEn,
        unitKind: material.unitKind,
        displayUnit: material.displayUnit,
        basePerDisplayMicro: material.basePerDisplay,
        isImported: material.isImported,
        leadTimeDays: material.leadTimeDays,
        minOrderQty: material.minOrderQty,
        purchaseIncrement: material.purchaseIncrement,
        basis: composition?.basis ?? null,
        qtyPerBasis: composition?.qtyPerBasis ?? null,
        supplier: composition?.supplier ?? null,
        overagePctScaled: overage.pctScaled,
        overageSource: overage.source,
        heldByLocationId: stockByMaterialId.get(material.id) ?? new Map(),
        factoryLocationId,
        willSendQty: null,
      },
      run,
    );
  });

  return { product, run, requirements };
}

export { computePlanInternal as computeBaselineRequirements };
