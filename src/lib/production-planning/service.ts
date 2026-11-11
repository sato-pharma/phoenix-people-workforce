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
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
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
import {
  evaluateExpiry,
  isIsoDate,
  resolveExpiryArming,
  splitExpiredLots,
  type ExpiryLot,
  type ExpiryVerdict,
} from "./expiry";
import { type DisplayWeightSource, shownBatchWeight, shownTotalWeight, shownUnitWeights } from "./display-weights";
import { formatExactRuns, resolveRunGeometry, type RunGeometry } from "./geometry";
import { formatOveragePct, learnFromRuns, resolveOverage, type MaterialLearning, type RunObservation } from "./learning";
import type { WireRetiredMaterial, WireRun, WireWorkspace } from "./wire";
import {
  resolveMaterialRequirement,
  sortRequirements,
  summariseRequirements,
  type MaterialRequirement,
  type MaterialRequirementInput,
  type OverageSource,
} from "./requirements";
import {
  coerceMeasureUnit,
  basisFitsProduct,
  COMPOSITION_BASES,
  formatPct,
  formatQty,
  MATERIAL_SUPPLIERS,
  MEASURE_UNITS_PER_LARGE,
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
  type MeasureUnit,
  type PlanRequestMode,
  type UnitKind,
} from "./rules";
import {
  coerceProductionPlanningLanguage,
  formatNumberLatin,
  type ProductionPlanningErrorKey,
  productionPlanningStrings,
  storedPlanTitle,
} from "./strings";
import { expiryChangeRows, isStockMovement, isStockSource, moveStockRows, storedStockQty, type StockSource } from "./stock";

const T = {
  products: "prodplan_products",
  materials: "prodplan_materials",
  productMaterials: "prodplan_product_materials",
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
  expiryEvents: "prodplan_expiry_events",
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
  "id, code, name_ar, name_en, manufacturer_name, run_volume_ml, dose_ml, good_unit_ml, sample_unit_ml, whole_runs_only, units_per_box, sample_in_own_box, strips_per_box, measure_unit, factory_location_id, default_sample_units, is_active, notes, batch_weight_display::text, unit_weight_display::text";
/** Which materials belong to which product. Before Guamusin every material belonged to the only one. */
const PRODUCT_MATERIAL_COLUMNS = "product_id, material_id, sort_order, is_active, supplier";
const MATERIAL_COLUMNS =
  "id, code, name_ar, name_en, unit_kind, base_unit, display_unit, base_per_display::text, is_imported, lead_time_days, min_order_qty::text, purchase_increment::text, reorder_cover_runs::text, is_active, sort_order, notes";
const COMPOSITION_COLUMNS =
  "id, product_id, material_id, unit_kind, basis, qty_per_basis::text, supplier, overage_pct::text, effective_from, effective_to, notes";
const LOCATION_COLUMNS = "id, code, name_ar, name_en, is_factory, is_active, sort_order";
// `expiry_date` makes a stock row a LOT: the same material at the same location can be held in two
// batches that die on different dates, which is the whole reason the owner asked for this column.
const STOCK_COLUMNS =
  "id, material_id, unit_kind, location_id, expiry_date, qty::text, as_of_date, source, note, created_at";
const PRICE_COLUMNS =
  "id, material_id, unit_kind, currency, price_per_display_unit::text, effective_from, supplier_name, note, created_at";
const FX_COLUMNS =
  "rate_date, fetched_usd_to_egp::text, fetch_ok, fetch_source, fetch_error, manual_usd_to_egp::text, manual_note";
const SETTINGS_COLUMNS =
  "id, default_overage_pct::text, reorder_cover_runs::text, alarm_enabled, alarm_dry_run, fx_fetch_enabled, fx_fetch_dry_run, fx_fallback_usd_to_egp::text, alarm_last_evaluated_on, alarm_last_sent_on, expiry_warn_days, expiry_alarm_enabled, expiry_alarm_dry_run, expiry_last_evaluated_on, expiry_last_sent_on, updated_by_hr_id, updated_by_login, updated_at";
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

/** The product's figures as the shown-weight helpers read them — the same shape the wire carries. */
function wireWeightSource(product: LoadedProduct): DisplayWeightSource {
  return {
    doseMl: product.geometry.doseMl.toString(),
    goodUnitMl: product.geometry.goodUnitMl.toString(),
    sampleUnitMl: product.geometry.sampleUnitMl.toString(),
    batchWeightDisplay: product.batchWeightDisplay ?? null,
    unitWeightDisplay: product.unitWeightDisplay ?? null,
  };
}

export type LoadedProduct = {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly manufacturerName: string | null;
  readonly geometry: RunGeometry;
  /** What the geometry is counted in. `ml` for a syrup, `g` for a powder in sachets. */
  readonly measureUnit: MeasureUnit;
  /**
   * THIS product's factory.
   *
   * 🔴 It is a product column and not `locations.is_factory` for a measured reason: every held-stock
   * split used to read `locations.find((l) => l.isFactory)`, which takes the FIRST flagged location.
   * Flagging DBK as a factory beside EGPI would therefore have re-pointed Ivyronc's factory to
   * whichever row sorted first — silently moving 72 kg of ivy extract from "the factory already has
   * it" to "send it". The column keeps each product's split its own.
   */
  readonly factoryLocationId: string | null;
  /**
   * The free-sample count the planner's Samples field opens on for THIS product
   * (`prodplan_products.default_sample_units`). Ivyronc and Guamusin keep the 10,000 the screen
   * always opened on; Royanoxicam is a tablet with no free samples, so it is 0. Before this column the
   * screen sent Ivyronc's 10,000 for every product, and 3 Royanoxicam runs read "590,000 tablets and
   * 10,000 samples" (owner, 2026-10-24). Optional only so a test can build a product without it —
   * an absent figure means no samples.
   */
  readonly defaultSampleUnits?: bigint;
  /**
   * The batch weight (large unit) and the tablet weight (small unit) the screen SHOWS, as decimal
   * strings, or null to show the geometry's own. Labels only — see `display-weights.ts`: nothing
   * that counts reads them (owner, 2026-11-11, Royafloxacin "847.6 mg, 70 kg as stated").
   */
  readonly batchWeightDisplay?: string | null;
  readonly unitWeightDisplay?: string | null;
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

/**
 * One LOT — material, location AND expiry date — not one location.
 *
 * Several rows can carry the same `(materialId, locationId)` pair with different `expiryDate`s. The
 * planner's held figure SUMS them (`heldByMaterialAndLocation`), so the buy list is unchanged; what
 * the lots add is the ability to say WHICH batch is about to die.
 */
export type LoadedStock = {
  readonly materialId: string;
  readonly locationId: string;
  /** `null` for packaging — film, cartons and stickers never expire. */
  readonly expiryDate: string | null;
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
  /** How far ahead the expiry warning looks. The owner asked for three months; the default is 90. */
  readonly expiryWarnDays: number;
  readonly expiryAlarmEnabled: boolean;
  readonly expiryAlarmDryRun: boolean;
  readonly expiryLastEvaluatedOn: string | null;
  readonly expiryLastSentOn: string | null;
  readonly updatedByLogin: string | null;
  readonly updatedAt: string | null;
};

/** Everything the planner needs in one shape, loaded once per request. */
export type ProductionPlanningData = {
  readonly level: ProductionPlanningLevel;
  readonly products: LoadedProduct[];
  readonly locations: LoadedLocation[];
  /**
   * EVERY material in the module, across all products. Almost nothing should read this directly —
   * use `materialsForProduct(data, productId)`, which filters through `materialIdsByProductId`.
   * An unscoped list puts one product's materials on another's buy list as "formula not entered".
   */
  readonly materials: LoadedMaterial[];
  /** Which materials belong to which product, from `prodplan_product_materials`. */
  readonly materialIdsByProductId: Map<string, Set<string>>;
  /**
   * Who brings a product's material when NO formula line is in force for it, from
   * `prodplan_product_materials.supplier` — product id → material id → supplier. Read it through
   * `effectiveSupplier`, never directly: a line in force always wins.
   *
   * 🔴 It exists for Royanoxicam's aluminium foil (owner, 2026-10-29: Sato supplies "the active
   * material, Laura Noxicam boxes, pamphlet, and aluminium foil only"). The foil has no line on his
   * own word ("leave empty for now"), so without this the screen could not tell it was Sato's and
   * filed it with the factory's materials. Optional so a hand-built fixture need not carry it.
   */
  readonly linkSupplierByProductId?: Map<string, Map<string, MaterialSupplier>>;
  readonly compositionsByProductId: Map<string, LoadedComposition[]>;
  /** The lots still in stock. Everything that counts as held reads this one. */
  readonly stock: LoadedStock[];
  /**
   * The lots whose expiry date has come (`splitExpiredLots`), kept for the accounts and counted as
   * held by nothing. Optional so a hand-built fixture need not carry it.
   */
  readonly expiredStock?: LoadedStock[];
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
  // Three months, as the owner asked for. The WINDOW is safe to default — it only decides what the
  // screen shows. The two arming flags below are the fail-safe pair, and both say "send nothing".
  expiryWarnDays: 90,
  expiryAlarmEnabled: false,
  expiryAlarmDryRun: true,
  expiryLastEvaluatedOn: null,
  expiryLastSentOn: null,
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

  const [
    productsRes,
    materialsRes,
    productMaterialsRes,
    compositionsRes,
    locationsRes,
    stockRes,
    pricesRes,
    settingsRes,
    fxRes,
  ] =
    await Promise.all([
      db.from(T.products).select(PRODUCT_COLUMNS).eq("is_active", true).order("code"),
      db.from(T.materials).select(MATERIAL_COLUMNS).eq("is_active", true).order("sort_order").order("code"),
      db.from(T.productMaterials).select(PRODUCT_MATERIAL_COLUMNS).eq("is_active", true),
      db.from(T.compositions).select(COMPOSITION_COLUMNS).lte("effective_from", today).order("effective_from", { ascending: false }),
      db.from(T.locations).select(LOCATION_COLUMNS).eq("is_active", true).order("sort_order"),
      db.from(T.stock).select(STOCK_COLUMNS).order("as_of_date", { ascending: false }).order("created_at", { ascending: false }),
      db.from(T.prices).select(PRICE_COLUMNS).lte("effective_from", today).order("effective_from", { ascending: false }),
      db.from(T.settings).select(SETTINGS_COLUMNS).eq("id", 1).maybeSingle(),
      db.from(T.fx).select(FX_COLUMNS).lte("rate_date", today).order("rate_date", { ascending: false }).limit(1).maybeSingle(),
    ]);

  if (productsRes.error) failure(productsRes.error, "load the products");
  if (materialsRes.error) failure(materialsRes.error, "load the materials");
  // 🔴 THROWS rather than falling back to "every material belongs to every product". A silent
  // fallback is how Guamusin's thirteen rows would appear on Ivyronc's buy list as "formula not
  // entered" — a wrong buy list reads exactly like a right one, which is the failure this module's
  // whole design avoids.
  if (productMaterialsRes.error) failure(productMaterialsRes.error, "load which materials each product uses");
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
    measureUnit: coerceMeasureUnit(row.measure_unit),
    // Falls back to the first flagged location ONLY where the column is null, which is how a product
    // seeded before this column existed still resolves. Ivyronc was backfilled to EGPI in the same
    // migration, so nothing actually takes this path.
    factoryLocationId: asText(row.factory_location_id),
    defaultSampleUnits: row.default_sample_units == null ? BigInt(0) : BigInt(row.default_sample_units),
    // Trimmed through the micro units, so numeric(14,4)'s "70.0000" reads 70 and "847.6000" 847.6.
    batchWeightDisplay: row.batch_weight_display == null ? null : formatQty(parseQty(String(row.batch_weight_display))),
    unitWeightDisplay: row.unit_weight_display == null ? null : formatQty(parseQty(String(row.unit_weight_display))),
    notes: asText(row.notes),
    geometry: {
      runVolumeMl: BigInt(row.run_volume_ml),
      doseMl: BigInt(row.dose_ml),
      goodUnitMl: BigInt(row.good_unit_ml),
      sampleUnitMl: BigInt(row.sample_unit_ml),
      wholeRunsOnly: row.whole_runs_only !== false,
      unitsPerBox: BigInt(row.units_per_box),
      sampleInOwnBox: row.sample_in_own_box === true,
      stripsPerBox: row.strips_per_box == null ? null : BigInt(row.strips_per_box),
    },
  }));

  const materialIdsByProductId = new Map<string, Set<string>>();
  const linkSupplierByProductId = new Map<string, Map<string, MaterialSupplier>>();
  for (const row of productMaterialsRes.data ?? []) {
    const productId = String(row.product_id);
    const ids = materialIdsByProductId.get(productId) ?? new Set<string>();
    ids.add(String(row.material_id));
    materialIdsByProductId.set(productId, ids);
    const linkSupplier = MATERIAL_SUPPLIERS.find((candidate) => candidate === row.supplier);
    if (linkSupplier) {
      const byMaterial = linkSupplierByProductId.get(productId) ?? new Map<string, MaterialSupplier>();
      byMaterial.set(String(row.material_id), linkSupplier);
      linkSupplierByProductId.set(productId, byMaterial);
    }
  }

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

  // Newest report per LOT — (material, location, expiry). Append-only means the history is all here;
  // the current figure is the first row for each lot, which is why the query sorts before this loop.
  //
  // 🔴 THE EXPIRY DATE IS PART OF THE KEY, and that is what makes two batches of the same powder at
  // the same factory two separate standing figures rather than one overwriting the other. Before
  // Guamusin every row had a null expiry, so each pair had exactly one lot and this fold returns the
  // identical array it always did — which is why the pinned Ivyronc figures do not move.
  const lots: LoadedStock[] = [];
  const seenStock = new Set<string>();
  for (const row of stockRes.data ?? []) {
    const expiryDate = asText(row.expiry_date);
    const key = `${String(row.material_id)}/${String(row.location_id)}/${expiryDate ?? ""}`;
    if (seenStock.has(key)) continue;
    seenStock.add(key);
    lots.push({
      materialId: String(row.material_id),
      locationId: String(row.location_id),
      expiryDate,
      qty: parseNonNegativeQty(String(row.qty), "qty"),
      asOfDate: String(row.as_of_date),
      source: String(row.source),
      note: asText(row.note),
    });
  }
  const { live: stock, expired: expiredStock } = splitExpiredLots(lots, todayCairo());

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
  const expiryArming = resolveExpiryArming(settingsRow);
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
        expiryWarnDays:
          typeof settingsRow.expiry_warn_days === "number" && settingsRow.expiry_warn_days > 0
            ? settingsRow.expiry_warn_days
            : DEFAULT_SETTINGS.expiryWarnDays,
        expiryAlarmEnabled: expiryArming.enabled,
        expiryAlarmDryRun: expiryArming.dryRun,
        expiryLastEvaluatedOn: asText(settingsRow.expiry_last_evaluated_on),
        expiryLastSentOn: asText(settingsRow.expiry_last_sent_on),
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
    materialIdsByProductId,
    linkSupplierByProductId,
    compositionsByProductId,
    stock,
    expiredStock,
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

// ── Reading the loaded data, per product ───────────────────────────────────────────────────────────

/**
 * The materials of ONE product, in their sorted order.
 *
 * 🔴 EVERY LIST OF MATERIALS GOES THROUGH HERE. The unscoped `data.materials` was correct only while
 * there was a single product, and the day a second one arrived it became a defect with no symptom:
 * Guamusin's thirteen materials would appear on Ivyronc's buy list as thirteen "formula not entered"
 * rows, and Ivyronc's fourteen on Guamusin's — a list that is wrong in a way that reads as right.
 *
 * A product with NO join rows gets every material, which is only how a product seeded before the
 * join table existed still works. Both real products were backfilled in the same migration.
 */
export function materialsForProduct(data: ProductionPlanningData, productId: string | null): LoadedMaterial[] {
  if (!productId) return [];
  const ids = data.materialIdsByProductId.get(productId);
  if (!ids || ids.size === 0) return data.materials;
  return data.materials.filter((material) => ids.has(material.id));
}

/**
 * Who brings this material for this product: the formula line in force, else the product link's own
 * `supplier`, else nobody has said (null).
 *
 * 🔴 The line always wins. The link answers only for a material with no line — Royanoxicam's foil
 * (Sato's, amount not entered yet) and its purified water and ethyl alcohol (the factory's, Q.S.).
 */
export function effectiveSupplier(
  data: ProductionPlanningData,
  productId: string | null,
  materialId: string,
  composition: { readonly supplier: MaterialSupplier } | null | undefined,
): MaterialSupplier | null {
  if (composition) return composition.supplier;
  if (!productId) return null;
  return data.linkSupplierByProductId?.get(productId)?.get(materialId) ?? null;
}

/**
 * The OTHER products that also use this material — what the Settings tab names before a retire.
 *
 * 🔴 Retiring is a MATERIAL-level switch, not a per-product one, so a material two products share
 * leaves the other product's buy list short the moment it is retired from either screen. The citric
 * acid anhydrous and the lemon flavour genuinely belong to both Ivyronc and Guamusin, so this is a
 * live case and not a hypothetical, and an understated warning here produces exactly the failure
 * this module keeps naming: a buy list that is wrong in a way that reads as right.
 *
 * 🔴 The no-join-rows case mirrors `materialsForProduct` deliberately. A product with no rows in
 * `prodplan_product_materials` gets EVERY material there, so it really does use this one, and
 * treating an absent entry as "does not use it" would hide the one product most at risk — one
 * seeded before the join table existed.
 */
export function otherProductsUsingMaterial(
  data: ProductionPlanningData,
  productId: string | null,
  materialId: string,
): LoadedProduct[] {
  return data.products.filter((product) => {
    if (product.id === productId) return false;
    const linked = data.materialIdsByProductId.get(product.id);
    return linked === undefined || linked.size === 0 || linked.has(materialId);
  });
}

/**
 * Held stock per material, per location — the lots SUMMED.
 *
 * This is the one place the lot split is collapsed, and collapsing it is deliberate: the requirement
 * engine asks "how much is at the factory", which is the total of every batch standing there. Keeping
 * the sum here rather than in `requirements.ts` is what lets the expiry work arrive without the buy
 * list moving by a single microgram — two lots of 100 and 130 answer 230, exactly as one row of 230
 * did before.
 */
function heldByMaterialAndLocation(stock: readonly LoadedStock[]): Map<string, Map<string, bigint>> {
  const byMaterial = new Map<string, Map<string, bigint>>();
  for (const row of stock) {
    const byLocation = byMaterial.get(row.materialId) ?? new Map<string, bigint>();
    byLocation.set(row.locationId, (byLocation.get(row.locationId) ?? BigInt(0)) + row.qty);
    byMaterial.set(row.materialId, byLocation);
  }
  return byMaterial;
}

/**
 * Which location is this product's factory.
 *
 * The product's own column, falling back to the first flagged location only when it is null — see
 * `LoadedProduct.factoryLocationId` for why a shared `is_factory` read was the bug.
 */
function factoryLocationIdFor(data: ProductionPlanningData, product: LoadedProduct): string | null {
  return product.factoryLocationId ?? data.locations.find((location) => location.isFactory)?.id ?? null;
}

/**
 * The stock ONE product can draw on — its own factory and Sato's own stores, never another factory.
 *
 * 🔴 Royanoxicam is made at TWO factories from 2026-10-29: Egyphar (no stock) and Medizen (old stock
 * of the active, the foil, the box and the leaflet). Without this filter Medizen's boxes sat in the
 * Egyphar plan's "Sato store" column and came off its buy list — stock in another factory's store
 * cannot be used in this factory's batch. The same was already true, unseen, of DBK's citric acid on
 * Ivyronc's plan. A product with no product given (`null`) keeps every lot.
 */
function stockForProduct(data: ProductionPlanningData, product: LoadedProduct | null | undefined): readonly LoadedStock[] {
  return lotsForProduct(data, product, data.stock);
}

/** The same scope over the expired lots, so a product never lists another factory's write-off. */
function expiredStockForProduct(data: ProductionPlanningData, product: LoadedProduct | null | undefined): readonly LoadedStock[] {
  return lotsForProduct(data, product, data.expiredStock ?? []);
}

function lotsForProduct(
  data: ProductionPlanningData,
  product: LoadedProduct | null | undefined,
  lots: readonly LoadedStock[],
): readonly LoadedStock[] {
  if (!product) return lots;
  const ownFactoryId = factoryLocationIdFor(data, product);
  const otherFactories = new Set(
    data.locations.filter((location) => location.isFactory && location.id !== ownFactoryId).map((location) => location.id),
  );
  if (otherFactories.size === 0) return lots;
  return lots.filter((row) => !otherFactories.has(row.locationId));
}

/** The lots of one product's materials, ready for `evaluateExpiry`. */
function expiryLotsFor(data: ProductionPlanningData, productId: string | null, today: string): ExpiryLot[] {
  const materials = materialsForProduct(data, productId);
  const byId = new Map(materials.map((material) => [material.id, material]));
  const lots: ExpiryLot[] = [];
  // Only the lots this product could use: the expiry sweep walks every product, so a lot at another
  // factory is still reported once, under the product made there.
  //
  // 🔴 A lot that expired TODAY is still reported, so the morning it leaves stock is announced once.
  // From tomorrow it is only in the Expired column, or the email would repeat it every day for ever.
  const product = data.products.find((candidate) => candidate.id === productId);
  const expiredToday = expiredStockForProduct(data, product).filter((row) => row.expiryDate === today);
  for (const row of [...stockForProduct(data, product), ...expiredToday]) {
    const material = byId.get(row.materialId);
    if (!material) continue;
    lots.push({
      code: material.code,
      expiryDate: row.expiryDate,
      locationId: row.locationId,
      materialId: material.id,
      nameAr: material.nameAr,
      nameEn: material.nameEn,
      qty: row.qty,
    });
  }
  return lots;
}

/** The expiry verdicts for one product, in the shape the screen and the email both read. */
export function evaluateExpiryForProduct(
  data: ProductionPlanningData,
  productId: string | null,
  today: string = todayCairo(),
): ExpiryVerdict[] {
  return evaluateExpiry(expiryLotsFor(data, productId, today), {
    today,
    warnDays: data.settings.expiryWarnDays,
  });
}

// ── Computing one plan ─────────────────────────────────────────────────────────────────────────────

/**
 * The validation messages for THIS request's language.
 *
 * Every write body carries `lang` (the workspace's own `post` puts it there), and an unreadable
 * or missing value is Arabic — the language the module was specified in. Taking it off the body
 * rather than threading a parameter through keeps every throw site one expression long.
 */
function stringsFor(body: { readonly lang?: unknown } | Record<string, unknown>) {
  return productionPlanningStrings(coerceProductionPlanningLanguage((body as { lang?: unknown }).lang));
}

function errorsFor(body: { readonly lang?: unknown } | Record<string, unknown>): Record<ProductionPlanningErrorKey, string> {
  return stringsFor(body).errors;
}

/**
 * The material's name in the reader's own language.
 *
 * Both names are stored on every material, so nothing is translated here — and an English name that
 * was never filled in falls back to the Arabic rather than leaving the sentence naming nothing,
 * which is the one outcome that makes a refusal useless.
 */
function materialNameFor(
  body: { readonly lang?: unknown } | Record<string, unknown>,
  material: { readonly nameAr: string; readonly nameEn: string },
): string {
  return stringsFor(body).name(material);
}

export type PlanRequestInput = {
  readonly productId?: unknown;
  readonly mode?: unknown;
  readonly requestedQty?: unknown;
  readonly sampleUnits?: unknown;
  /** An overage typed on the screen for this one calculation, overriding every other source. */
  readonly overridePct?: unknown;
  /** Per material, what he has decided to deliver — keyed by material id, as a decimal string. */
  readonly willSendByMaterialId?: unknown;
  /**
   * Which language the SENTENCE under the tiles is built in, since the owner chose the module's
   * language with a toggle (2026-10-06). Anything other than `"en"` is Arabic, which keeps a
   * missing or unknown value on the language the module was specified in.
   *
   * Only the sentence: every other word in this payload is either data (a name, which carries both
   * languages and is picked by the reader's bundle) or a key the screen looks up in its own
   * catalogue. The screen builds its own copy of this sentence from the bundle it is rendering
   * in; this one is what the WORKBOOK's header line reads, so the sheet cannot be in one language
   * and its title in the other.
   */
  readonly lang?: unknown;
};

export function parsePlanRequest(body: PlanRequestInput, data: ProductionPlanningData) {
  const productId = asText(body.productId) ?? data.products[0]?.id ?? null;
  if (!productId) throw new ProductionPlanningInputError(errorsFor(body).noProductToPlan, "productId");
  const product = data.products.find((candidate) => candidate.id === productId);
  if (!product) throw new ProductionPlanningInputError(errorsFor(body).productNotFound, "productId");

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
  readonly productNameEn: string;
  /** What the `…Ml` and `…Litres` figures below are counted in — grams and kilograms for a powder. */
  readonly measureUnit: MeasureUnit;
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
  readonly oneRunFewer: {
    runs: string;
    packagingSets: string;
    totalBoxes: string;
    shortfallBoxes: string;
  } | null;
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
  const factoryLocationId = factoryLocationIdFor(data, product);
  const stockByMaterialId = heldByMaterialAndLocation(stockForProduct(data, product));
  const priceByMaterialId = new Map(data.prices.map((row) => [row.materialId, row]));

  const materials = materialsForProduct(data, product.id);
  const requirements: MaterialRequirement[] = [];
  const inputsByMaterialId = new Map<string, MaterialRequirementInput>();
  for (const material of materials) {
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
      supplier: effectiveSupplier(data, product.id, material.id, composition),
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
    const material = materials.find((candidate) => candidate.id === row.materialId)!;
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
  // The product's own measure unit picks the divisor — 1,000 for a litre or a kilogram, 1,000,000
  // for the kilogram a milligram geometry is read in. The wire field is still called
  // `…Litres` for the one product that existed when it was named, like the `_ml` columns.
  const perLarge = MEASURE_UNITS_PER_LARGE[product.measureUnit];
  const litres = (ml: bigint) => formatQty((ml * QTY_SCALE) / perLarge);
  // What he READS for the batch and the tablet — the stated figures where a product carries them
  // (Royafloxacin's 70 kg and 847.6 mg), the geometry's own everywhere else. Never used to count.
  const weightSource = wireWeightSource(product);
  const shownRunVolume = shownBatchWeight(weightSource, litres(product.geometry.runVolumeMl));
  const shownTotalVolume = shownTotalWeight(weightSource, run.runs, litres(run.totalVolumeMl));
  const shownUnits = shownUnitWeights(weightSource);

  // Grouped Latin digits, built here rather than in the component, so the sentence under the tiles
  // and the workbook's own header line read identically.
  const sentence = productionPlanningStrings(coerceProductionPlanningLanguage(asScalar(body.lang))).plannerSentence({
    runs: formatNumberLatin(run.runs),
    runVolumeLitres: formatNumberLatin(shownRunVolume),
    totalVolumeLitres: formatNumberLatin(shownTotalVolume),
    goodUnits: formatNumberLatin(run.goodUnits),
    goodUnitMl: formatNumberLatin(shownUnits.goodUnit),
    sampleUnits: formatNumberLatin(run.sampleUnits),
    sampleUnitMl: formatNumberLatin(shownUnits.sampleUnit),
    surplusBoxes: formatNumberLatin(run.surplusBoxes),
    shortfallBoxes: null,
    // So the sentence says "6 runs of 100 kg each … 5 g sachets" for a powder, and keeps every word
    // of Ivyronc's litres-and-millilitres wording for a syrup.
    measureUnit: product.measureUnit,
  });

  return {
    productId: product.id,
    productNameAr: product.nameAr,
    productNameEn: product.nameEn,
    measureUnit: product.measureUnit,
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
    totalVolumeLitres: shownTotalVolume,
    runVolumeLitres: shownRunVolume,
    totalDoses: run.totalDoses.toString(),
    leftoverMl: run.leftoverMl.toString(),
    oneRunFewer: run.oneRunFewer
      ? {
          runs: run.oneRunFewer.runs.toString(),
          packagingSets: run.oneRunFewer.packagingSets.toString(),
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

/**
 * Recorded runs, newest first, with their per-material actuals beside their own theory.
 *
 * Filtered by product when one is named: the Run tab belongs to the product the Planner tab is on,
 * and a run of Ivyronc listed under Guamusin would be read as Guamusin's own history — which is also
 * what the consumption learner would then be measuring.
 */
export async function listRuns(access: AccessContext, productId?: string | null) {
  const level = await resolveProductionPlanningLevel(access);
  assertProductionPlanningRead(access, level);
  const db = getSupabaseAdmin();
  const runsQuery = db.from(T.runs).select(RUN_COLUMNS).order("produced_on", { ascending: false }).limit(60);
  const [runsRes, linesRes] = await Promise.all([
    productId ? runsQuery.eq("product_id", productId) : runsQuery,
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
export async function listPlans(access: AccessContext, productId?: string | null) {
  const level = await resolveProductionPlanningLevel(access);
  assertProductionPlanningRead(access, level);
  const query = getSupabaseAdmin()
    .from(T.plans)
    .select(PLAN_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(40);
  const { data, error } = await (productId ? query.eq("product_id", productId) : query);
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
 * The RETIRED materials — `is_active = false` — for the Settings tab's restore list.
 *
 * 🔴 Deliberately a separate read, and deliberately NOT a field on `ProductionPlanningData`. Putting
 * it there would make an inactive material reachable from `computePlan`, and a retired material back
 * on a buy list is exactly the double-count the leaflet split exists to prevent: 68,250 pieces of
 * superseded artwork covering new production, with every figure on the row still looking ordinary.
 * Nothing that computes a plan may see this list.
 */
async function listRetiredMaterials(): Promise<WireRetiredMaterial[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(T.materials)
    .select("id, code, name_ar, name_en")
    .eq("is_active", false)
    .order("code");
  if (error) failure(error, "load the retired materials");
  return (data ?? []).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    nameAr: String(row.name_ar),
    nameEn: String(row.name_en),
  }));
}

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
/**
 * A read that names no sample count gets the PRODUCT's own default, never a module-wide one.
 *
 * Only an ABSENT count is filled in — `undefined` or `null`, which is what the workspace GET and the
 * workbook GET hand over when the query string has no `sampleUnits`. A count he typed, an empty field
 * included, is his answer and passes through untouched: an empty field still means zero samples.
 * The screen's first read of every product sends no count, so Royanoxicam opens on 0 samples and the
 * other two on their 10,000, and the form then takes its figure from the plan it is showing.
 */
export function withProductSampleDefault(body: PlanRequestInput, data: ProductionPlanningData): PlanRequestInput {
  if (body.sampleUnits !== undefined && body.sampleUnits !== null) return body;
  const productId = asText(body.productId) ?? data.products[0]?.id ?? null;
  const product = data.products.find((candidate) => candidate.id === productId);
  if (!product) return body;
  return { ...body, sampleUnits: (product.defaultSampleUnits ?? BigInt(0)).toString() };
}

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
  const plan =
    data.products.length > 0 && askedForAPlan ? computePlan(data, withProductSampleDefault(body, data)) : null;

  // 🔴 WHICH PRODUCT THE WHOLE PAYLOAD BELONGS TO, resolved once and used by every array below.
  //
  // It used to be `data.products[0]` in four places and nowhere else, which was the same product
  // either way while there was only one. With two, the Stock, Cost, Run and Settings tabs were all
  // reading product one's formula and product one's runs no matter which product the Planner tab was
  // showing — so a Guamusin material's basis read "formula not entered" while its formula sat in the
  // database. The requested id wins; the first product is only the default for a bare first load.
  const productId = asText(body.productId) ?? data.products[0]?.id ?? null;
  const materials = materialsForProduct(data, productId);
  const compositions = productId ? data.compositionsByProductId.get(productId) ?? [] : [];
  const compositionByMaterialId = new Map(compositions.map((row) => [row.materialId, row]));
  // Hoisted out of the map below: folding every lot once per material is quadratic, and the stock
  // table is the longest list on this screen. Only the selected product's own factory and Sato's
  // stores: the Stock tab must agree with the plan beside it.
  const selectedProduct = data.products.find((candidate) => candidate.id === productId);
  const productStock = stockForProduct(data, selectedProduct);
  const productExpired = expiredStockForProduct(data, selectedProduct);
  const heldByMaterial = heldByMaterialAndLocation(productStock);
  const lotsByMaterialAndLocation = new Map<string, LoadedStock[]>();
  for (const row of productStock) {
    const key = `${row.materialId}/${row.locationId}`;
    const list = lotsByMaterialAndLocation.get(key) ?? [];
    list.push(row);
    lotsByMaterialAndLocation.set(key, list);
  }
  const [runs, plans, retiredMaterials] = await Promise.all([
    listRuns(access, productId),
    listPlans(access, productId),
    listRetiredMaterials(),
  ]);

  return {
    level: data.level,
    canWrite: data.level === "full",
    productId,
    retiredMaterials,
    // EVERY material in the module, names and units only — the list "Fix a wrong material" picks
    // the right one from (owner, 2026-11-11: Saginkgo's foil had been entered on Guamusin's film).
    // `materials` stays the selected product's own, for the reason on `WireWorkspace.materials`.
    allMaterials: data.materials.map((material) => ({
      id: material.id,
      code: material.code,
      nameAr: material.nameAr,
      nameEn: material.nameEn,
      unitKind: material.unitKind,
      displayUnit: material.displayUnit,
      basePerDisplay: formatQty(material.basePerDisplay),
      productIds: data.products
        .filter((product) => materialsForProduct(data, product.id).some((own) => own.id === material.id))
        .map((product) => product.id),
    })),
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
      sampleInOwnBox: product.geometry.sampleInOwnBox === true,
      stripsPerBox: product.geometry.stripsPerBox == null ? null : product.geometry.stripsPerBox.toString(),
      measureUnit: product.measureUnit,
      factoryLocationId: factoryLocationIdFor(data, product),
      batchWeightDisplay: product.batchWeightDisplay ?? null,
      unitWeightDisplay: product.unitWeightDisplay ?? null,
      notes: product.notes,
    })),
    locations: data.locations,
    materials: materials.map((material) => {
      const composition = compositionByMaterialId.get(material.id);
      const learned = data.learning.get(material.id);
      const price = data.prices.find((row) => row.materialId === material.id) ?? null;
      const expired = productExpired.filter((row) => row.materialId === material.id);
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
        alsoUsedByProductIds: otherProductsUsingMaterial(data, productId, material.id).map(
          (product) => product.id,
        ),
        supplier: effectiveSupplier(data, productId, material.id, composition),
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
        // One row per LOT, soonest expiry first, with the undated packaging lots last. The screen
        // reads this straight into its own rows, so the order here IS the order he sees.
        stock: productStock
          .filter((row) => row.materialId === material.id)
          .slice()
          .sort((a, b) => (a.expiryDate ?? "9999-12-31").localeCompare(b.expiryDate ?? "9999-12-31"))
          .map((row) => ({
            locationId: row.locationId,
            expiryDate: row.expiryDate,
            qty: formatQty(row.qty),
            qtyDisplay: display(row.qty, material.basePerDisplay),
            asOfDate: row.asOfDate,
            source: row.source,
            note: row.note,
          })),
        expiredStock: expired
          .slice()
          .sort((a, b) => (a.expiryDate ?? "").localeCompare(b.expiryDate ?? ""))
          .map((row) => ({
            locationId: row.locationId,
            expiryDate: row.expiryDate,
            qty: formatQty(row.qty),
            qtyDisplay: display(row.qty, material.basePerDisplay),
            asOfDate: row.asOfDate,
            source: row.source,
            note: row.note,
          })),
        expiredTotalDisplay:
          expired.length === 0
            ? null
            : display(expired.reduce((sum, row) => sum + row.qty, BigInt(0)), material.basePerDisplay),
        // Summed HERE, in BigInt, for the same reason the delivery arithmetic is server-side: the
        // screen would have to add decimal strings in floats, and this module exists to avoid that.
        heldByLocation: [...(heldByMaterial.get(material.id)?.entries() ?? [])].map(([locationId, qty]) => {
          const lots = lotsByMaterialAndLocation.get(`${material.id}/${locationId}`) ?? [];
          return {
            locationId,
            lots: lots.length,
            newestAsOfDate: lots.map((row) => row.asOfDate).sort().at(-1) ?? "",
            qty: formatQty(qty),
            qtyDisplay: display(qty, material.basePerDisplay),
          };
        }),
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
      expiryWarnDays: data.settings.expiryWarnDays,
      expiryAlarmEnabled: data.settings.expiryAlarmEnabled,
      expiryAlarmDryRun: data.settings.expiryAlarmDryRun,
      expiryLastEvaluatedOn: data.settings.expiryLastEvaluatedOn,
      expiryLastSentOn: data.settings.expiryLastSentOn,
      updatedByLogin: data.settings.updatedByLogin,
      updatedAt: data.settings.updatedAt,
    },
    fx: {
      rate: data.fx.usdToEgpMicro === null ? null : formatQty(data.fx.usdToEgpMicro),
      rateDate: data.fx.rateDate,
      source: data.fx.source,
    },
    plan,
    // Computed on EVERY load, armed or not: the banner is the half he reads, and the email is a
    // separate switch he has not turned on. "خانة الاكسبايري ديت مهمة جدا جدا جدا" — so the warning
    // is on the screen from the first load, with no cron and no arming involved.
    expiry: evaluateExpiryForProduct(data, productId).map((verdict) => {
      const material = materials.find((candidate) => candidate.id === verdict.materialId);
      return {
        code: verdict.code,
        daysLeft: verdict.daysLeft,
        displayUnit: material?.displayUnit ?? "",
        expiryDate: verdict.expiryDate,
        locationId: verdict.locationId,
        materialId: verdict.materialId,
        nameAr: verdict.nameAr,
        nameEn: verdict.nameEn,
        qty: formatQty(verdict.qty),
        qtyDisplay: material ? display(verdict.qty, material.basePerDisplay) : formatQty(verdict.qty),
        severity: verdict.severity,
      };
    }),
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

/**
 * Append a stock report. Nothing is ever overwritten — the newest row IS the current figure.
 *
 * A **delivery** is the one movement source (owner, 2026-10-06): he types what he SENT and the
 * balance goes up by it, because "Delivery: 100" plainly means 100 arrived, not that 100 is all
 * there is. Every other source is a balance somebody counted and is stored exactly as typed. The
 * ruling, the reason and the arithmetic live in `stock.ts`.
 */
export async function addStockEntry(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const materialId = asText(body.materialId);
  const locationId = asText(body.locationId);
  if (!materialId || !locationId) {
    throw new ProductionPlanningInputError(errorsFor(body).materialAndLocationRequired, "materialId");
  }
  const unitKind = UNIT_KINDS.find((candidate) => candidate === body.unitKind);
  if (!unitKind) throw new ProductionPlanningInputError(errorsFor(body).unknownUnitKind, "unitKind");
  const qty = parseNonNegativeQty(asScalar(body.qty), "qty");
  const asOfDate = asText(body.asOfDate) ?? todayCairo();
  // The LOT this report is about. Absent means "the undated lot" — packaging, which never expires,
  // and every Ivyronc row recorded before the column existed.
  const expiryDate = asText(body.expiryDate);
  if (expiryDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
    throw new ProductionPlanningInputError(errorsFor(body).expiryDateInvalid, "expiryDate");
  }
  // Validated here rather than left to the table's CHECK: a rejected CHECK surfaces as a raw
  // PostgREST message, which is not a sentence anybody should read on a form.
  const sourceText = asText(body.source) ?? "factory_report";
  if (!isStockSource(sourceText)) {
    throw new ProductionPlanningInputError(errorsFor(body).unknownStockSource, "source");
  }
  const source: StockSource = sourceText;

  const db = getSupabaseAdmin();

  // A delivery adds to the balance standing on its OWN date. It refuses to guess when a LATER
  // report already exists, because that report has either counted this delivery already or
  // superseded it — adding underneath it would invent a figure nobody reported.
  //
  // 🔴 BOTH READS ARE SCOPED TO THIS LOT. A delivery of the batch expiring in April 2027 adds to
  // that batch's standing figure, not to the batch expiring in 2029 — and the "is there a newer
  // report" refusal likewise only asks about this lot, or a second batch arriving today would be
  // refused because the FIRST batch happens to carry a later report.
  let previousQty = BigInt(0);
  if (isStockMovement(source)) {
    const standingQuery = db
      .from(T.stock)
      .select("qty::text")
      .eq("material_id", materialId)
      .eq("location_id", locationId)
      .lte("as_of_date", asOfDate);
    const newerQuery = db
      .from(T.stock)
      .select("as_of_date")
      .eq("material_id", materialId)
      .eq("location_id", locationId)
      .gt("as_of_date", asOfDate);
    const [standing, newer] = await Promise.all([
      (expiryDate === null ? standingQuery.is("expiry_date", null) : standingQuery.eq("expiry_date", expiryDate))
        .order("as_of_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      (expiryDate === null ? newerQuery.is("expiry_date", null) : newerQuery.eq("expiry_date", expiryDate))
        .order("as_of_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (standing.error) failure(standing.error, "read the balance this delivery adds to");
    if (newer.error) failure(newer.error, "check for a newer stock report");
    if (newer.data?.as_of_date) {
      throw new ProductionPlanningInputError(
        stringsFor(body).refusals.deliveryBehindANewerReport(String(newer.data.as_of_date)),
        "asOfDate",
      );
    }
    previousQty = standing.data?.qty ? parseNonNegativeQty(standing.data.qty, "qty") : BigInt(0);
  }

  const storedQty = storedStockQty({ previousQty, source, typedQty: qty });

  const { data, error } = await db
    .from(T.stock)
    .insert({
      material_id: materialId,
      unit_kind: unitKind,
      location_id: locationId,
      expiry_date: expiryDate,
      qty: formatQty(storedQty),
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
    newValues: {
      materialId,
      locationId,
      expiryDate,
      qty: formatQty(storedQty),
      typedQty: formatQty(qty),
      previousQty: formatQty(previousQty),
      asOfDate,
      source,
    },
    summary: isStockMovement(source)
      ? `Production planner: delivery of ${formatQty(qty)} for material ${materialId} at ${locationId}${expiryDate ? ` (lot expiring ${expiryDate})` : ""} — balance ${formatQty(previousQty)} → ${formatQty(storedQty)} as of ${asOfDate}`
      : `Production planner: stock report for material ${materialId} at ${locationId}${expiryDate ? ` (lot expiring ${expiryDate})` : ""} — ${formatQty(storedQty)} as of ${asOfDate}`,
  });

  return {
    id: data?.id ? String(data.id) : null,
    previousQty: formatQty(previousQty),
    storedQty: formatQty(storedQty),
    typedQty: formatQty(qty),
  };
}

/**
 * Move a lot to another expiry date, or give an undated lot its date.
 *
 * Append-only like every stock report: the arithmetic and the reason it takes two rows are in
 * `expiryChangeRows`. A lot whose new date has already passed goes to the Expired column on the next
 * read, and an expired lot given a later date comes back into stock, with nothing else to undo.
 */
export async function changeStockLotExpiry(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const materialId = asText(body.materialId);
  const locationId = asText(body.locationId);
  if (!materialId || !locationId) {
    throw new ProductionPlanningInputError(errorsFor(body).materialAndLocationRequired, "materialId");
  }
  const fromExpiryDate = asText(body.fromExpiryDate);
  const toExpiryDate = asText(body.toExpiryDate);
  if (fromExpiryDate !== null && !isIsoDate(fromExpiryDate)) {
    throw new ProductionPlanningInputError(errorsFor(body).expiryDateInvalid, "fromExpiryDate");
  }
  if (toExpiryDate !== null && !isIsoDate(toExpiryDate)) {
    throw new ProductionPlanningInputError(errorsFor(body).expiryDateInvalid, "toExpiryDate");
  }
  if (fromExpiryDate === toExpiryDate) {
    throw new ProductionPlanningInputError(errorsFor(body).expiryDateUnchanged, "toExpiryDate");
  }

  const db = getSupabaseAdmin();
  const standingOn = (expiryDate: string | null) => {
    const query = db
      .from(T.stock)
      .select("qty::text, as_of_date, unit_kind")
      .eq("material_id", materialId)
      .eq("location_id", locationId);
    return (expiryDate === null ? query.is("expiry_date", null) : query.eq("expiry_date", expiryDate))
      .order("as_of_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  };
  const [fromRes, targetRes] = await Promise.all([standingOn(fromExpiryDate), standingOn(toExpiryDate)]);
  if (fromRes.error) failure(fromRes.error, "read the lot being moved");
  if (targetRes.error) failure(targetRes.error, "read the lot on the new expiry date");

  const fromQty = fromRes.data?.qty ? parseNonNegativeQty(fromRes.data.qty, "qty") : BigInt(0);
  if (!fromRes.data || fromQty <= BigInt(0)) {
    throw new ProductionPlanningInputError(errorsFor(body).stockLotNotFound, "fromExpiryDate");
  }

  const rows = expiryChangeRows({
    from: { asOfDate: String(fromRes.data.as_of_date), qty: fromQty },
    fromExpiryDate,
    target: targetRes.data
      ? { asOfDate: String(targetRes.data.as_of_date), qty: parseNonNegativeQty(targetRes.data.qty, "qty") }
      : null,
    toExpiryDate,
  });
  const unitKind = fromRes.data.unit_kind;
  const note = `Expiry date changed from ${fromExpiryDate ?? "none"} to ${toExpiryDate ?? "none"}`;
  const { error } = await db.from(T.stock).insert(
    rows.map((row) => ({
      as_of_date: row.asOfDate,
      expiry_date: row.expiryDate,
      location_id: locationId,
      material_id: materialId,
      note,
      qty: formatQty(row.qty),
      recorded_by_hr_id: who.hrId,
      recorded_by_login: who.login,
      source: "adjustment",
      unit_kind: unitKind,
    })),
  );
  if (error) failure(error, "change the expiry date");

  await writeAuditLog({
    actorLoginId: who.login,
    entityType: "production_stock_entry",
    entityId: null,
    newValues: { materialId, locationId, fromExpiryDate, toExpiryDate, qty: formatQty(fromQty) },
    summary: `Production planner: ${formatQty(fromQty)} of material ${materialId} at ${locationId} moved from expiry ${fromExpiryDate ?? "none"} to ${toExpiryDate ?? "none"}`,
  });

  return { qty: formatQty(fromQty), toExpiryDate };
}

/**
 * Move stock out of one lot and into another — to a different store, or onto the material it should
 * have been entered on (owner, 2026-11-11, who chose both tools after one night needed each of them by
 * hand: Saginkgo's stock split between the factory and Sato's store, and 576.885 kg of Saginkgo's
 * foil recorded on Guamusin's sachet film).
 *
 * Exactly one of `toLocationId` and `toMaterialId`. The lot keeps its expiry date either way — a move
 * is not a re-dating, which has its own tool. A blank quantity moves the whole lot. Two materials must
 * be counted the same way (weight, volume or count), because a number of grams is not a number of
 * pieces. Append-only, two rows, the arithmetic in `moveStockRows`; recorded with
 * `writeRequiredAuditLog`, because a move nobody can trace is stock that vanished from one place and
 * appeared in another.
 */
export async function moveStock(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const materialId = asText(body.materialId);
  const locationId = asText(body.locationId);
  if (!materialId || !locationId) {
    throw new ProductionPlanningInputError(errorsFor(body).materialAndLocationRequired, "materialId");
  }
  const expiryDate = asText(body.expiryDate);
  if (expiryDate !== null && !isIsoDate(expiryDate)) {
    throw new ProductionPlanningInputError(errorsFor(body).expiryDateInvalid, "expiryDate");
  }
  const toLocationId = asText(body.toLocationId);
  const toMaterialId = asText(body.toMaterialId);
  const destinations = [toLocationId && toLocationId !== locationId, toMaterialId && toMaterialId !== materialId];
  if (destinations.filter(Boolean).length !== 1) {
    throw new ProductionPlanningInputError(
      errorsFor(body).moveDestinationRequired,
      toMaterialId ? "toMaterialId" : "toLocationId",
    );
  }
  const targetMaterialId = toMaterialId ?? materialId;
  const targetLocationId = toLocationId ?? locationId;
  const typedQty = asScalar(body.qty);
  const asOfDate = asText(body.asOfDate) ?? todayCairo();
  if (!isIsoDate(asOfDate)) throw new ProductionPlanningInputError(errorsFor(body).expiryDateInvalid, "asOfDate");

  const db = getSupabaseAdmin();
  const standingOn = (material: string, location: string) => {
    const query = db
      .from(T.stock)
      .select("qty::text, as_of_date, unit_kind")
      .eq("material_id", material)
      .eq("location_id", location);
    return (expiryDate === null ? query.is("expiry_date", null) : query.eq("expiry_date", expiryDate))
      .order("as_of_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  };
  const [fromRes, targetRes, materialsRes, locationRes] = await Promise.all([
    standingOn(materialId, locationId),
    standingOn(targetMaterialId, targetLocationId),
    db.from(T.materials).select("id, unit_kind").in("id", [materialId, targetMaterialId]),
    db.from(T.locations).select("id").eq("id", targetLocationId).maybeSingle(),
  ]);
  if (fromRes.error) failure(fromRes.error, "read the lot being moved");
  if (targetRes.error) failure(targetRes.error, "read the lot it moves into");
  if (materialsRes.error) failure(materialsRes.error, "read the two materials");
  if (locationRes.error) failure(locationRes.error, "read the store it moves into");

  const unitKindOf = new Map((materialsRes.data ?? []).map((row) => [String(row.id), String(row.unit_kind)]));
  if (!unitKindOf.has(targetMaterialId)) {
    throw new ProductionPlanningInputError(errorsFor(body).materialNotFound, "toMaterialId");
  }
  if (!locationRes.data) {
    throw new ProductionPlanningInputError(errorsFor(body).materialAndLocationRequired, "toLocationId");
  }
  if (unitKindOf.get(targetMaterialId) !== unitKindOf.get(materialId)) {
    throw new ProductionPlanningInputError(errorsFor(body).moveUnitKindMismatch, "toMaterialId");
  }

  const fromQty = fromRes.data?.qty ? parseNonNegativeQty(fromRes.data.qty, "qty") : BigInt(0);
  if (!fromRes.data || fromQty <= BigInt(0)) {
    throw new ProductionPlanningInputError(errorsFor(body).stockLotNotFound, "expiryDate");
  }
  const qty = typedQty === null || String(typedQty).trim() === "" ? fromQty : parseNonNegativeQty(typedQty, "qty");
  if (qty <= BigInt(0)) throw new ProductionPlanningInputError(errorsFor(body).qtyMustBePositive, "qty");

  const rows = moveStockRows({
    asOfDate,
    from: { asOfDate: String(fromRes.data.as_of_date), qty: fromQty },
    qty,
    target: targetRes.data
      ? { asOfDate: String(targetRes.data.as_of_date), qty: parseNonNegativeQty(targetRes.data.qty, "qty") }
      : null,
  });
  if (!rows) throw new ProductionPlanningInputError(errorsFor(body).moveQtyTooLarge, "qty");

  const what = toMaterialId
    ? `moved from material ${materialId} to material ${targetMaterialId}`
    : `moved from ${locationId} to ${targetLocationId}`;
  const note = asText(body.note) ?? `Stock ${what}`;
  const unitKind = unitKindOf.get(materialId);
  const base = {
    expiry_date: expiryDate,
    note,
    recorded_by_hr_id: who.hrId,
    recorded_by_login: who.login,
    source: "adjustment",
    unit_kind: unitKind,
  };
  const { error } = await db.from(T.stock).insert([
    { ...base, as_of_date: rows.from.asOfDate, location_id: locationId, material_id: materialId, qty: formatQty(rows.from.qty) },
    {
      ...base,
      as_of_date: rows.to.asOfDate,
      location_id: targetLocationId,
      material_id: targetMaterialId,
      qty: formatQty(rows.to.qty),
    },
  ]);
  if (error) failure(error, "move the stock");

  await writeRequiredAuditLog({
    actorLoginId: who.login,
    entityType: "production_stock_entry",
    entityId: null,
    newValues: {
      materialId,
      locationId,
      expiryDate,
      toMaterialId: targetMaterialId,
      toLocationId: targetLocationId,
      qty: formatQty(qty),
      fromLeft: formatQty(rows.from.qty),
      toNow: formatQty(rows.to.qty),
      asOfDate: rows.from.asOfDate,
    },
    summary: `Production planner: ${formatQty(qty)} ${what}${expiryDate ? ` (lot expiring ${expiryDate})` : ""} — ${formatQty(rows.from.qty)} left, ${formatQty(rows.to.qty)} now there, as of ${rows.from.asOfDate}`,
  });

  return { qty: formatQty(qty), fromLeft: formatQty(rows.from.qty), toNow: formatQty(rows.to.qty) };
}

/**
 * How many units and strips one box of a product holds — the two figures a per-box, per-strip or
 * per-packaging-set formula line divides by.
 *
 * Until 2026-11-11 neither had a Settings edit, so a wrong strip count could only be fixed in the
 * database. The owner chose to have them editable that night, beside the per-1,000-boxes entry that
 * reads them. Strips per box may be cleared only while no per-strip line is in force for the product:
 * a strip line on a product with no strips would ask for nothing, for ever (the same refusal the
 * formula save makes from the other side). The limits are the table's own CHECKs, checked here so a
 * refusal reads as a sentence and not a raw database message.
 */
export async function updateProductPackaging(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const productId = asText(body.productId);
  if (!productId) throw new ProductionPlanningInputError(errorsFor(body).productNotFound, "productId");
  const unitsText = asText(asScalar(body.unitsPerBox) === null ? null : String(asScalar(body.unitsPerBox)));
  const stripsText = asText(asScalar(body.stripsPerBox) === null ? null : String(asScalar(body.stripsPerBox)));
  const wholeInRange = (text: string | null) =>
    text !== null && /^\d{1,4}$/.test(text) && Number(text) >= 1 && Number(text) <= 1000;
  if (!wholeInRange(unitsText)) {
    throw new ProductionPlanningInputError(errorsFor(body).unitsPerBoxInvalid, "unitsPerBox");
  }
  if (stripsText !== null && !wholeInRange(stripsText)) {
    throw new ProductionPlanningInputError(errorsFor(body).stripsPerBoxInvalid, "stripsPerBox");
  }
  const unitsPerBox = Number(unitsText);
  const stripsPerBox = stripsText === null ? null : Number(stripsText);
  // The two SHOWN weights (owner, 2026-11-11) — labels only, never counted. A key that is absent
  // leaves the stored figure alone; present and blank clears it, so the geometry's own shows again.
  const shownWeight = (key: "batchWeightDisplay" | "unitWeightDisplay"): string | null | undefined => {
    if (!(key in body)) return undefined;
    const raw = asScalar(body[key]);
    const text = raw === null ? null : asText(String(raw));
    if (text === null) return null;
    if (!/^\d{1,7}(?:\.\d{1,4})?$/.test(text) || Number(text) <= 0 || Number(text) > 1_000_000) {
      throw new ProductionPlanningInputError(errorsFor(body).shownWeightInvalid, key);
    }
    return text;
  };
  const batchWeightDisplay = shownWeight("batchWeightDisplay");
  const unitWeightDisplay = shownWeight("unitWeightDisplay");

  const db = getSupabaseAdmin();
  const today = todayCairo();
  const [previous, stripLines] = await Promise.all([
    db
      .from(T.products)
      .select("units_per_box, strips_per_box, batch_weight_display::text, unit_weight_display::text")
      .eq("id", productId)
      .maybeSingle(),
    db
      .from(T.compositions)
      .select("id")
      .eq("product_id", productId)
      .eq("basis", "per_strip")
      .lte("effective_from", today)
      .or(`effective_to.is.null,effective_to.gt.${today}`)
      .limit(1),
  ]);
  if (previous.error) failure(previous.error, "read the product");
  if (stripLines.error) failure(stripLines.error, "read the product's per-strip lines");
  if (!previous.data) throw new ProductionPlanningInputError(errorsFor(body).productNotFound, "productId");
  if (stripsPerBox === null && (stripLines.data ?? []).length > 0) {
    throw new ProductionPlanningInputError(errorsFor(body).stripsInUse, "stripsPerBox");
  }

  const { error } = await db
    .from(T.products)
    .update({
      strips_per_box: stripsPerBox,
      units_per_box: unitsPerBox,
      ...(batchWeightDisplay === undefined ? {} : { batch_weight_display: batchWeightDisplay }),
      ...(unitWeightDisplay === undefined ? {} : { unit_weight_display: unitWeightDisplay }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", productId);
  if (error) failure(error, "save the packaging");

  const before = {
    stripsPerBox: previous.data.strips_per_box ?? null,
    unitsPerBox: previous.data.units_per_box,
    batchWeightDisplay: asText(previous.data.batch_weight_display),
    unitWeightDisplay: asText(previous.data.unit_weight_display),
  };
  const after = {
    stripsPerBox,
    unitsPerBox,
    batchWeightDisplay: batchWeightDisplay === undefined ? before.batchWeightDisplay : batchWeightDisplay,
    unitWeightDisplay: unitWeightDisplay === undefined ? before.unitWeightDisplay : unitWeightDisplay,
  };
  await writeRequiredAuditLog({
    actorLoginId: who.login,
    entityType: "production_product",
    entityId: productId,
    oldValues: before,
    newValues: after,
    summary: `Production planner: product ${productId} packaging — units per box ${before.unitsPerBox} → ${unitsPerBox}, strips per box ${before.stripsPerBox ?? "none"} → ${stripsPerBox ?? "none"}, shown batch weight ${before.batchWeightDisplay ?? "none"} → ${after.batchWeightDisplay ?? "none"}, shown unit weight ${before.unitWeightDisplay ?? "none"} → ${after.unitWeightDisplay ?? "none"}`,
  });

  return {
    productId,
    stripsPerBox: stripsPerBox === null ? null : String(stripsPerBox),
    unitsPerBox: String(unitsPerBox),
    batchWeightDisplay: after.batchWeightDisplay,
    unitWeightDisplay: after.unitWeightDisplay,
  };
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
  if (!materialId) throw new ProductionPlanningInputError(errorsFor(body).materialRequired, "materialId");
  const unitKind = UNIT_KINDS.find((candidate) => candidate === body.unitKind);
  if (!unitKind) throw new ProductionPlanningInputError(errorsFor(body).unknownUnitKind, "unitKind");
  const currency: Currency | undefined = body.currency === "USD" ? "USD" : body.currency === "EGP" ? "EGP" : undefined;
  if (!currency) throw new ProductionPlanningInputError(errorsFor(body).unknownCurrency, "currency");
  const price = parseNonNegativeQty(asScalar(body.pricePerDisplayUnit), "pricePerDisplayUnit");
  if (price <= BigInt(0)) throw new ProductionPlanningInputError(errorsFor(body).priceMustBePositive, "pricePerDisplayUnit");
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
  if (!product) throw new ProductionPlanningInputError(errorsFor(body).productNotFound, "productId");

  const runLabel = asText(body.runLabel);
  if (!runLabel) throw new ProductionPlanningInputError(errorsFor(body).runLabelRequired, "runLabel");
  const runsCount = parseWholeCount(asScalar(body.runsCount) ?? 1, "runsCount", { min: BigInt(1), max: BigInt(1000) });
  const actualGoodUnits = parseWholeCount(asScalar(body.actualGoodUnits) ?? 0, "actualGoodUnits", { min: BigInt(0) });
  const actualSampleUnits = parseWholeCount(asScalar(body.actualSampleUnits) ?? 0, "actualSampleUnits", { min: BigInt(0) });
  const producedOn = asText(body.producedOn) ?? todayCairo();
  const isExcluded = body.isExcludedFromLearning === true;
  const exclusionReason = asText(body.exclusionReason);
  if (isExcluded && !exclusionReason) {
    throw new ProductionPlanningInputError(errorsFor(body).exclusionReasonRequired, "exclusionReason");
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
  // Scoped to the product's own materials: a line naming a material this product does not use is a
  // posted id the screen could not have offered, and recording it would teach the consumption learner
  // about a material the run never touched.
  const runMaterials = materialsForProduct(data, product.id);
  const rows = lines.map((line) => {
    const materialId = asText(line.materialId);
    if (!materialId) throw new ProductionPlanningInputError(errorsFor(body).rowMaterialMissingId, "materials");
    const material = runMaterials.find((candidate) => candidate.id === materialId);
    if (!material) throw new ProductionPlanningInputError(errorsFor(body).rowMaterialNotFound, "materials");
    const opening = parseNonNegativeQty(asScalar(line.openingQty) ?? "0", "openingQty");
    const delivered = parseNonNegativeQty(asScalar(line.deliveredQty) ?? "0", "deliveredQty");
    const closing = parseNonNegativeQty(asScalar(line.closingQty) ?? "0", "closingQty");
    if (closing > opening + delivered) {
      throw new ProductionPlanningInputError(
        stringsFor(body).refusals.closingOverOpening(materialNameFor(body, material)),
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
  if (typeof body.expiryAlarmEnabled === "boolean") patch.expiry_alarm_enabled = body.expiryAlarmEnabled;
  if (typeof body.expiryAlarmDryRun === "boolean") patch.expiry_alarm_dry_run = body.expiryAlarmDryRun;
  if (asText(body.expiryWarnDays) !== null) {
    // Refused here rather than left to the table's CHECK, so he reads a sentence and not a PostgREST
    // message. The ceiling is three years: a window longer than that warns about everything.
    const days = Number(parseWholeCount(asScalar(body.expiryWarnDays), "expiryWarnDays", {
      min: BigInt(1),
      max: BigInt(1095),
    }));
    patch.expiry_warn_days = days;
  }
  if (asText(body.fxFallbackUsdToEgp) !== null) {
    patch.fx_fallback_usd_to_egp = formatQty(parseNonNegativeQty(asScalar(body.fxFallbackUsdToEgp), "fxFallbackUsdToEgp"));
  }

  const { error } = await db.from(T.settings).upsert(patch, { onConflict: "id" });
  if (error) failure(error, "save the settings");

  const armingChanged =
    (typeof body.alarmEnabled === "boolean" && body.alarmEnabled !== (previous.data?.alarm_enabled === true)) ||
    (typeof body.alarmDryRun === "boolean" && body.alarmDryRun !== (previous.data?.alarm_dry_run !== false)) ||
    (typeof body.expiryAlarmEnabled === "boolean" &&
      body.expiryAlarmEnabled !== (previous.data?.expiry_alarm_enabled === true)) ||
    (typeof body.expiryAlarmDryRun === "boolean" &&
      body.expiryAlarmDryRun !== (previous.data?.expiry_alarm_dry_run !== false));

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
          expiryWarnDays: previous.data.expiry_warn_days,
          expiryAlarmEnabled: previous.data.expiry_alarm_enabled,
          expiryAlarmDryRun: previous.data.expiry_alarm_dry_run,
        }
      : null,
    newValues: patch,
    summary: armingChanged
      ? `Production planner: email arming changed — reorder enabled=${patch.alarm_enabled ?? previous.data?.alarm_enabled}, dryRun=${patch.alarm_dry_run ?? previous.data?.alarm_dry_run}; expiry enabled=${patch.expiry_alarm_enabled ?? previous.data?.expiry_alarm_enabled}, dryRun=${patch.expiry_alarm_dry_run ?? previous.data?.expiry_alarm_dry_run}`
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
  if (rate <= BigInt(0)) throw new ProductionPlanningInputError(errorsFor(body).fxRateMustBePositive, "usdToEgp");

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
  if (!materialId) throw new ProductionPlanningInputError(errorsFor(body).materialRequired, "materialId");

  const previous = await db.from(T.materials).select(MATERIAL_COLUMNS).eq("id", materialId).maybeSingle();
  if (!previous.data) throw new ProductionPlanningInputError(errorsFor(body).materialNotFound, "materialId");

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
    if (!basis) throw new ProductionPlanningInputError(errorsFor(body).unknownBasis, "basis");
    if (basis === "per_strip") {
      // A strip line on a product with no strips would save and then ask for nothing, for ever.
      const owner = await db.from(T.products).select("strips_per_box").eq("id", productId).maybeSingle();
      if (owner.error) failure(owner.error, "read the product");
      if (!basisFitsProduct(basis, owner.data?.strips_per_box)) {
        throw new ProductionPlanningInputError(errorsFor(body).stripBasisNeedsStrips, "basis");
      }
    }
    if (!supplier) throw new ProductionPlanningInputError(errorsFor(body).unknownSupplier, "supplier");
    const qtyPerBasis = parseNonNegativeQty(asScalar(body.qtyPerBasis), "qtyPerBasis");
    if (qtyPerBasis <= BigInt(0)) throw new ProductionPlanningInputError(errorsFor(body).qtyMustBePositive, "qtyPerBasis");
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

/**
 * RETIRE a material, or bring a retired one back — `prodplan_materials.is_active`.
 *
 * 🔴 DEACTIVATE, NEVER DELETE. That is this module's own settled precedent, three times over: the
 * pre-split combined `LEAFLET`, `STICKER_GUAMUSIN` when the owner corrected his packaging list, and
 * `LEAFLET_OLD` when he said to forget the old artwork. Deleting a material would destroy the stock
 * report EGPI actually sent, and the written-off quantity IS the record. **Stock rows are never
 * touched here** — the 68,250 old leaflets stay on the books exactly as they are.
 *
 * What a retire does, and the order is the safety:
 *
 *  1. CLOSES every formula row in force, `effective_to = today`, never a delete — so a plan
 *     committed last month still reproduces under the formula it was committed with. Rows opened
 *     TODAY are left alone for the same reason `saveMaterialAndComposition` does: closing a row at
 *     its own `effective_from` is not a window the database accepts, and the material is about to
 *     become invisible anyway.
 *  2. Switches off the `prodplan_product_materials` rows, so the link is remembered rather than
 *     dropped and a restore puts the material back on the products it belonged to.
 *  3. Switches off the material.
 *
 * Reversed on the way back, and both orders are chosen so a failure half-way leaves the SAFE state:
 * a material still active with no formula line reads "formula not entered" on screen, which is
 * visible and harmless, while a hidden material holding a live formula row would quietly restore a
 * requirement nobody asked for.
 *
 * 🔴 A RESTORE DOES NOT RE-OPEN THE FORMULA ROWS. He re-enters the line deliberately, because a
 * reactivation that also revived the old quantity is how two leaflet lines would start covering new
 * production with every figure on the row still looking ordinary.
 */
export async function setMaterialActive(access: AccessContext, body: Record<string, unknown>) {
  await assertWrite(access);
  const who = actor(access);
  const db = getSupabaseAdmin();
  const materialId = asText(body.materialId);
  if (!materialId) throw new ProductionPlanningInputError(errorsFor(body).materialRequired, "materialId");
  if (typeof body.active !== "boolean") {
    throw new ProductionPlanningInputError(errorsFor(body).activeFlagRequired, "active");
  }
  const active = body.active;

  const previous = await db.from(T.materials).select(MATERIAL_COLUMNS).eq("id", materialId).maybeSingle();
  if (!previous.data) throw new ProductionPlanningInputError(errorsFor(body).materialNotFound, "materialId");

  const today = todayCairo();
  const now = new Date().toISOString();
  let closedCompositionIds: string[] = [];

  if (!active) {
    const { data: closed, error: closeError } = await db
      .from(T.compositions)
      .update({ effective_to: today, updated_at: now })
      .eq("material_id", materialId)
      .is("effective_to", null)
      .lt("effective_from", today)
      .select("id");
    if (closeError) failure(closeError, "close the formula rows");
    closedCompositionIds = (closed ?? []).map((row) => String(row.id));
  }

  const { error: joinError } = await db
    .from(T.productMaterials)
    .update({ is_active: active })
    .eq("material_id", materialId);
  if (joinError) failure(joinError, active ? "restore the product links" : "switch off the product links");

  const { error: materialError } = await db
    .from(T.materials)
    .update({ is_active: active, updated_at: now })
    .eq("id", materialId);
  if (materialError) failure(materialError, active ? "restore the material" : "retire the material");

  await writeAuditLog({
    actorLoginId: who.login,
    entityType: "production_material",
    entityId: materialId,
    oldValues: { isActive: previous.data.is_active },
    newValues: { isActive: active, closedCompositionIds },
    summary: active
      ? `Production planner: material ${previous.data.code} restored — its product links are back on and its formula line must be re-entered`
      : `Production planner: material ${previous.data.code} retired — ${closedCompositionIds.length} formula row(s) closed at ${today}, stock kept`,
  });

  return { materialId, active, closedCompositions: closedCompositionIds.length };
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
      stringsFor(body).refusals.unsettledSuppliers(
        unsettledInBuyList.map((row) => materialNameFor(body, row)),
      ),
      "supplier",
    );
  }

  // The stored title is ALWAYS the Arabic one, and a `title` on the request body is ignored rather
  // than honoured (owner, 2026-10-06: "drop the body.title override so the stored plan title is
  // always Arabic"). Until then this read `asText(body.title) ?? storedPlanTitle(…)`, so the
  // ruling — Arabic whoever saves it — held only because no caller happens to send the field: the
  // planner's commit POST carries productId, mode, requestedQty, sampleUnits, overridePct,
  // willSendByMaterialId and commit. Anyone holding `production_planning:create` could store a
  // title in any language, and a future screen with a title box would have broken the rule with
  // every test still green. Ignoring the field IS the ruling; rejecting it with an error would
  // invent a failure mode for something nothing sends. Pinned by
  // `tests/production-planning-strings.test.ts`.
  const title = storedPlanTitle(result.productNameAr, result.runs);
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
      // A material with no line in force has no basis to snapshot — the link's supplier now names
      // who brings Royanoxicam's foil, so the supplier alone no longer means a line exists.
      .filter((row) => (row.supplier === "sato" || row.supplier === "factory") && row.basis !== null)
      .map((row) => {
        const material = materialsForProduct(data, result.productId).find(
          (candidate) => candidate.id === row.materialId,
        )!;
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
  if (!hrId) throw new ProductionPlanningInputError(errorsFor(body).hrIdRequired, "hrId");
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
  if (!level) throw new ProductionPlanningInputError(errorsFor(body).unknownAccessLevel, "level");

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

/**
 * Who holds a stored grant. Full control only: it names people and what they can see.
 *
 * The NAMES come from the shared `namesByHrId` — the owner's standing rule is names, never codes or
 * ids, and the mixed-case trap behind that lookup is not hand-rolled here. This screen's own copy
 * used to be, and it read the whole grant list in ONE unchunked `.in()`: correct for the handful of
 * rows it holds today and the exact shape that returns zero names and no error once a list grows.
 * A grant whose holder cannot be resolved still renders, falling back to the id.
 */
export async function listAccessGrants(access: AccessContext) {
  await assertWrite(access);
  const { data, error } = await getSupabaseAdmin()
    .from(T.grants)
    .select("hr_id, level, note, granted_by_login, created_at")
    .order("hr_id");
  if (error) failure(error, "load the grants");
  const rows = data ?? [];
  const names = await namesByHrId(rows.map((row) => String(row.hr_id)));
  return rows.map((row) => ({
    hrId: String(row.hr_id),
    personName: names.get(String(row.hr_id)),
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
  for (const material of materialsForProduct(data, product.id)) {
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
  const factoryLocationId = factoryLocationIdFor(data, product);
  const stockByMaterialId = heldByMaterialAndLocation(stockForProduct(data, product));

  const requirements = materialsForProduct(data, productId).map((material) => {
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
        supplier: effectiveSupplier(data, productId, material.id, composition),
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
