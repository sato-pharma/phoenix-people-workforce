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
export type WireBasis = "per_dose" | "per_packaging_set" | "per_good_unit" | "per_sample_unit";
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
  notes: string | null;
};

export type WireLocation = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  isFactory: boolean;
};

export type WireStockRow = {
  locationId: string;
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
  composition: {
    basis: WireBasis;
    qtyPerBasis: string;
    supplier: WireSupplier;
    overagePct: string | null;
    effectiveFrom: string;
    notes: string | null;
  } | null;
  stock: WireStockRow[];
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
  oneRunFewer: { runs: string; totalBoxes: string; shortfallBoxes: string } | null;
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
  updatedByLogin: string | null;
  updatedAt: string | null;
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
  level: "full" | "read";
  note: string | null;
  grantedByLogin: string | null;
  createdAt: string | null;
};

export type WireWorkspace = {
  level: WireLevel;
  canWrite: boolean;
  products: WireProduct[];
  locations: WireLocation[];
  materials: WireMaterial[];
  settings: WireSettings;
  fx: { rate: string | null; rateDate: string | null; source: WireFxSource };
  plan: WirePlan | null;
  runs: WireRun[];
  plans: WireSavedPlan[];
};
