/**
 * Production Planner — the shapes that travel between the routes and the screen.
 *
 * Client-safe on purpose: the workspace is a `"use client"` component and `service.ts` imports the
 * Supabase admin client, so the two cannot share a file. These types are declared here rather than
 * in the component so the workbook builder reads the same shape the screen does.
 *
 * 🔴 EVERY QUANTITY, PRICE, PERCENTAGE AND MONEY FIELD IS A STRING. Inside the module a quantity is
 * a BigInt count of micro base units, and `JSON.stringify` cannot carry a BigInt — so each one
 * crosses as its decimal TEXT and is formatted for display with `formatNumberLatin`. Never
 * `Number(...)` one of these to compare or add it: that is the double this module exists to avoid,
 * and it is why the service reads every numeric column with `select("qty::text")`.
 */

export type WireLevel = "full" | "read" | "none";
export type WireUnitKind = "mass" | "count";
export type WireSupplier = "sato" | "factory" | "shared_unsettled";
export type WireBasis = "per_dose" | "per_packaging_set" | "per_good_unit" | "per_sample_unit" | "per_box" | "per_strip";
/**
 * The unit a product's geometry is counted in: `ml` for a syrup, `g` for a powder in sachets, `mg`
 * for a tablet (155 mg is not a whole gram, and the geometry columns are integers).
 */
export type WireMeasureUnit = "ml" | "g" | "mg" | "mg_capsule";
export type WireRequestMode = "total_boxes" | "good_units" | "runs";
export type WireCurrency = "USD" | "EGP";
export type WireOverageSource = "measured" | "material" | "default";
export type WireFxSource = "manual" | "fetched" | "fallback" | "none";

export type WireProduct = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  manufacturerName: string | null;
  runVolumeMl: string;
  doseMl: string;
  goodUnitMl: string;
  sampleUnitMl: string;
  wholeRunsOnly: boolean;
  unitsPerBox: string;
  /** True when one sample is a whole box of its own, as Saginkgo's box of five capsules is. */
  sampleInOwnBox?: boolean;
  /** Blister strips in one saleable box, for a product whose foil is counted by the strip. */
  stripsPerBox?: string | null;
  /**
   * What the four `…Ml` figures above are counted in. The arithmetic never cared — a run is
   * `runVolumeMl / doseMl` whatever the unit — but the LABELS did, and a powder in 5 g sachets was
   * reading "5 مل" on his screen. The column names keep their `Ml` spelling so no migration renames
   * four columns the whole module reads; this field is what the labels follow.
   */
  measureUnit: WireMeasureUnit;
  /** Which location is THIS product's factory. A second product means a second factory. */
  factoryLocationId: string | null;
  /**
   * The batch weight (large unit) and one unit's weight (small unit) as the factory and the paper
   * state them, or null to show the geometry's own. LABELS ONLY — `display-weights.ts`.
   */
  batchWeightDisplay?: string | null;
  unitWeightDisplay?: string | null;
  notes: string | null;
};

export type WireLocation = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  isFactory: boolean;
};

/**
 * One LOT of one material at one location — not one location.
 *
 * 🔴 Several rows can carry the same `locationId`. The owner's reason (2026-10-08): "انا عندي حاجات
 * هتنتهي 4 27 فانا لازم انتبه لها" — the factory holds the same powder in batches that expire on
 * different dates, and a single summed figure cannot tell him which one is about to die. So stock is
 * keyed by material + location + expiry, and the planner's held-quantity arithmetic sums the lots.
 */
export type WireStockRow = {
  locationId: string;
  /** `null` for packaging — aluminium film, cartons and stickers never expire (his words). */
  expiryDate: string | null;
  qty: string;
  qtyDisplay: string;
  asOfDate: string;
  source: string;
  note: string | null;
};

export type WireMaterial = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unitKind: WireUnitKind;
  baseUnit: string;
  displayUnit: string;
  basePerDisplay: string;
  isImported: boolean;
  leadTimeDays: number | null;
  minOrderQty: string | null;
  purchaseIncrement: string | null;
  reorderCoverRuns: string | null;
  notes: string | null;
  /**
   * The OTHER products that also use this material — ids, so the screen resolves the names through
   * `S.name(product)` and an English reader never reads an Arabic product name.
   *
   * 🔴 It exists so the retire control cannot quietly change a product nobody is looking at.
   * Retiring is a MATERIAL-level switch, and the citric acid anhydrous and the lemon flavour
   * genuinely belong to both Ivyronc and Guamusin — so retiring one from Ivyronc's screen takes it
   * off Guamusin's buy list too, which is precisely the shape this module keeps warning about: a
   * list that is wrong in a way that reads as right. Empty for a material only this product uses.
   */
  alsoUsedByProductIds: string[];
  /**
   * Who brings it for THIS product: the formula line in force, else the product link's own supplier,
   * else null (nobody has said). The Cost and Stock tabs list only what Sato buys
   * (`isBoughtBySato`), so Royanoxicam's foil — Sato's, with no line yet — must read Sato here.
   */
  supplier: WireSupplier | null;
  composition: {
    basis: WireBasis;
    qtyPerBasis: string;
    supplier: WireSupplier;
    overagePct: string | null;
    effectiveFrom: string;
    notes: string | null;
  } | null;
  /** Every LOT, soonest expiry first. Several rows can share a `locationId`. */
  stock: WireStockRow[];
  /**
   * The lots whose expiry date has come, oldest first. They are off every held figure and stay here
   * for the accounts. Optional because a saved fixture may predate them.
   */
  expiredStock?: WireStockRow[];
  /** Those lots summed server-side in BigInt, for the same reason as `heldByLocation`. */
  expiredTotalDisplay?: string | null;
  /**
   * The lots SUMMED per location — computed server-side, in BigInt base units.
   *
   * 🔴 The screen must not add the lots itself. `qtyDisplay` figures are decimal strings and
   * `Number("4284.8") * 1000` is 4284799.999999999 in binary floating point; this module exists so
   * the screen, the stored row and the Excel formula carry the same digits. Same reason the delivery
   * arithmetic lives in the service.
   */
  heldByLocation: {
    locationId: string;
    qty: string;
    qtyDisplay: string;
    /** The newest report date across this location's lots, so the screen can say how fresh it is. */
    newestAsOfDate: string;
    /** How many lots are behind that total. `1` for everything that has no expiry date. */
    lots: number;
  }[];
  price: {
    currency: WireCurrency;
    pricePerDisplayUnit: string;
    effectiveFrom: string;
    supplierName: string | null;
  } | null;
  learning: {
    runsCounted: string;
    consumedTotal: string;
    theoreticalTotal: string;
    impliedOveragePct: string | null;
    recommendedOveragePct: string | null;
    withheldReason: "not_enough_runs" | "no_theoretical_figure" | null;
  } | null;
};

export type WirePlanRow = {
  materialId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unitKind: WireUnitKind;
  displayUnit: string;
  supplier: WireSupplier | null;
  basis: WireBasis | null;
  overagePct: string;
  overageSource: WireOverageSource;
  isImported: boolean;
  leadTimeDays: number | null;
  basisCount: string;
  rawNeeded: string;
  needed: string;
  neededPerRun: string;
  heldAtFactory: string;
  heldElsewhere: string;
  heldTotal: string;
  toBuy: string;
  minToDeliver: string;
  willSend: string;
  balanceAfter: string;
  balanceAfterRuns: string | null;
  coverRuns: string | null;
  contributesToBuyList: boolean;
  excludedReason: "factory_supplies" | "supplier_unsettled" | "no_composition" | null;
  priceCurrency: WireCurrency | null;
  pricePerDisplayUnit: string | null;
  costUsd: string | null;
  costEgp: string | null;
  costDerivedMissing: boolean;
};

export type WirePlan = {
  productId: string;
  productNameAr: string;
  productNameEn: string;
  /**
   * The unit the `…Ml` and `…Litres` figures below are counted in. For Guamusin they are grams and
   * kilograms; the field names keep their syrup spelling so the engine stays one code path.
   */
  measureUnit: WireMeasureUnit;
  mode: WireRequestMode;
  requestedQty: string;
  sampleUnits: string;
  runs: string;
  exactRuns: string;
  rounded: boolean;
  goodUnits: string;
  packagingSets: string;
  totalBoxes: string;
  requestedBoxes: string;
  surplusBoxes: string;
  totalVolumeMl: string;
  totalVolumeLitres: string;
  runVolumeLitres: string;
  totalDoses: string;
  leftoverMl: string;
  /**
   * `packagingSets` here is the SALEABLE-UNIT count for this scenario, emitted beside the box count
   * so the note can read "108,000 كيس (9,000 علبة)" without the browser multiplying anything. The
   * module is BigInt micro units exactly so the screen never owns a quantity calculation.
   */
  oneRunFewer: { runs: string; packagingSets: string; totalBoxes: string; shortfallBoxes: string } | null;
  sentence: string;
  rows: WirePlanRow[];
  totals: {
    materials: number;
    toBuyCount: number;
    unsettled: number;
    factorySupplied: number;
    withoutComposition: number;
    shortAfterRunCount: number;
    costUsd: string;
    costEgp: string;
    unpricedMaterials: number;
    incompleteMaterials: number;
    fxRate: string | null;
    fxSource: WireFxSource;
    fxRateDate: string | null;
  };
};

export type WireSettings = {
  defaultOveragePct: string;
  reorderCoverRuns: string;
  alarmEnabled: boolean;
  alarmDryRun: boolean;
  fxFetchEnabled: boolean;
  fxFetchDryRun: boolean;
  fxFallbackUsdToEgp: string | null;
  alarmLastEvaluatedOn: string | null;
  alarmLastSentOn: string | null;
  /** How far ahead the expiry warning looks. The owner asked for three months — 90 days. */
  expiryWarnDays: number;
  expiryAlarmEnabled: boolean;
  expiryAlarmDryRun: boolean;
  expiryLastEvaluatedOn: string | null;
  expiryLastSentOn: string | null;
  updatedByLogin: string | null;
  updatedAt: string | null;
};

/**
 * One lot that is already expired or inside the warning window.
 *
 * Separate from the reorder alarm on purpose: a material can be plentiful AND about to expire, and
 * the two verdicts answer different questions ("order more" vs "use this one first").
 */
export type WireExpiryVerdict = {
  materialId: string;
  code: string;
  nameAr: string;
  nameEn: string;
  locationId: string;
  expiryDate: string;
  qty: string;
  qtyDisplay: string;
  displayUnit: string;
  /** Negative once the date has passed. */
  daysLeft: number;
  severity: "expired" | "critical" | "warning";
};

export type WireRun = {
  id: string;
  productId: string;
  planId: string | null;
  runLabel: string;
  runsCount: string;
  actualGoodUnits: string;
  actualSampleUnits: string;
  producedOn: string;
  isExcludedFromLearning: boolean;
  exclusionReason: string | null;
  notes: string | null;
  recordedByLogin: string | null;
  materials: {
    materialId: string;
    openingQty: string;
    deliveredQty: string;
    closingQty: string;
    consumedQty: string;
    theoreticalQty: string | null;
    note: string | null;
  }[];
};

export type WireSavedPlan = {
  id: string;
  productId: string;
  title: string;
  requestMode: string;
  requestedQty: string;
  sampleUnits: string;
  status: string;
  runs: string | null;
  goodUnits: string | null;
  packagingSets: string | null;
  overagePct: string | null;
  fxUsdToEgp: string | null;
  fxRateDate: string | null;
  notes: string | null;
  createdByLogin: string | null;
  committedAt: string | null;
  committedByLogin: string | null;
  createdAt: string | null;
};

export type WireGrant = {
  hrId: string;
  /**
   * The person's NAME, for the owner's standing "names, never codes or ids" rule.
   *
   * `null` when the lookup found nothing — someone who has left, or a failed read. The screen then
   * falls back to the id, which is exactly what this list showed before: a missing name is reported
   * as missing rather than replaced by an invented one.
   */
  personName: string | null;
  level: "full" | "read";
  note: string | null;
  grantedByLogin: string | null;
  createdAt: string | null;
};

/**
 * A material that has been RETIRED — `prodplan_materials.is_active = false`.
 *
 * It carries only what the Settings tab needs to name it and offer it back, because a retired
 * material has no formula line in force and no place on any buy list. 🔴 This list is GLOBAL, not
 * scoped to the selected product: retiring deactivates the `prodplan_product_materials` rows too,
 * so scoping it by that join would return an empty list every time and the restore control would
 * never appear.
 */
export type WireRetiredMaterial = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
};

/** One material of the whole module, for a picker that crosses products. */
export type WireMaterialRef = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  unitKind: WireMaterial["unitKind"];
  displayUnit: string;
  basePerDisplay: string;
  /** The products it belongs to, so a picker can say where each one is used. */
  productIds: string[];
};

export type WireWorkspace = {
  level: WireLevel;
  canWrite: boolean;
  products: WireProduct[];
  locations: WireLocation[];
  /**
   * The retired materials, so a retire is REVERSIBLE from the same screen that did it.
   *
   * 🔴 Without this the control would be a one-way door: `loadProductionPlanningDataAtLevel` reads
   * materials with `is_active = true`, so a material switched off vanishes from every tab and only a
   * database write could bring it back — which is the hole the retire control exists to close, in
   * the opposite direction.
   */
  retiredMaterials: WireRetiredMaterial[];
  /** Every material across every product — names and units only. `materials` is the selected product's. */
  allMaterials: WireMaterialRef[];
  /**
   * 🔴 THE MATERIALS OF THE SELECTED PRODUCT ONLY, and `productId` says which one.
   *
   * Before Guamusin this was every material in the module, which was the same list either way
   * because there was one product. With two, an unscoped list puts Guamusin's thirteen "formula not
   * entered" rows on Ivyronc's buy list — so the service filters through `prodplan_product_materials`
   * and every tab reads this array as already belonging to that product.
   */
  materials: WireMaterial[];
  /** Which product the `materials`, `plan`, `runs`, `plans` and `expiry` arrays belong to. */
  productId: string | null;
  settings: WireSettings;
  fx: { rate: string | null; rateDate: string | null; source: WireFxSource };
  plan: WirePlan | null;
  expiry: WireExpiryVerdict[];
  runs: WireRun[];
  plans: WireSavedPlan[];
};
