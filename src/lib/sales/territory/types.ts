import type { PhoenixRole } from "@/lib/auth/permissions";

import type { TerritoryWindow } from "./window";

export type TerritoryRootLevel = "area" | "region" | "nationwide";

export type TerritoryDiagnosticCode =
  | "area_unresolved"
  | "region_unresolved"
  | "line_unresolved"
  | "role_unsupported";

export type TerritoryDiagnostic = {
  code: TerritoryDiagnosticCode;
  message: string;
};

/**
 * The module-specific hard-lock resolution result. This is NOT a UI default — every level
 * here is a real server-side access boundary, re-derived on every request (see service.ts).
 */
export type TerritoryRootScope =
  | { level: "area"; sosAreaCodes: string[]; officialLine: string }
  | { level: "region"; regionCodes: string[]; officialLine: string }
  | { level: "nationwide"; officialLine: string }
  | { level: "denied"; diagnostic: TerritoryDiagnostic };

export type TerritoryRegionNode = {
  regionCode: string;
  regionName: string;
};

export type TerritoryAreaNode = {
  areaCode: string;
  areaName: string;
  regionCode: string;
};

export type TerritoryBlockNode = {
  blockCode: string;
  /** "" when the block has no description on file — the block has no name column in the
   *  system, so the display layer always falls back to showing blockCode as the label. */
  blockName: string;
  areaCode: string;
};

export type TerritoryBrickNode = {
  brickId: string;
  brickName: string;
  blockCode: string;
  areaCode: string;
};

/**
 * The Tier-1 geography skeleton — names + codes only, zero sales figures, bounded to the
 * viewer's root scope. Cheap master data, safe to load in full on every page visit (see
 * territory/skeleton.ts for why this differs from the expensive per-area pharmacy fetch).
 */
export type TerritorySkeleton = {
  role: PhoenixRole;
  officialLine: string;
  rootLevel: TerritoryRootLevel;
  regions: TerritoryRegionNode[];
  areas: TerritoryAreaNode[];
  blocks: TerritoryBlockNode[];
  bricks: TerritoryBrickNode[];
  /** The exact locked area-code set for a Medical Rep; null for every other role (their
   *  scope is bounded by region/nationwide instead — every area under it is fetchable). */
  rootAreaCodes: string[] | null;
  diagnostic: TerritoryDiagnostic | null;
  /** The months the figures cover and on what basis (published closing or live) — attached by
   *  getTerritorySkeleton, so the page labels the same window the per-area fetch reads. */
  window?: TerritoryWindow;
};

export type TerritoryProductBreakdown = {
  productCode: string;
  productName: string;
  units: number;
  value: number;
};

export type TerritoryMonthPresence = {
  period: string;
  hasSales: boolean;
  /** This pharmacy's sales VALUE for the month — the trend bar's height. Value, never a
   *  units total: a units total is only meaningful for one product_code, so summing the
   *  units of different products (Saginko + Royafloxacin) into one bar is forbidden (owner
   *  golden rule). Value is additive across products and is the correct trend basis. */
  value: number;
  /** Per-product units for this pharmacy in this month — drives the trend tooltip
   *  (e.g. "Saginko 100 units, Royafloxacin 70 units"). Each line is one product, so its
   *  units ARE valid; only the summed-across-products total is not. Empty when hasSales is false. */
  products: TerritoryProductBreakdown[];
};

export type TerritoryPharmacy = {
  clientCode: string;
  clientName: string;
  brickId: string;
  totalUnits: number;
  totalValue: number;
  months: TerritoryMonthPresence[];
};

export type TerritoryBrickPharmacies = {
  brickId: string;
  pharmacies: TerritoryPharmacy[];
};

/**
 * One official_line x period row of the post-sync reconciliation proof: the rebuilt directory
 * rollup (what the drilldown reads) summed against the raw validated import rows on the same
 * grain. `reconciled` is true when every measure matches within epsilon AND no row sits on a
 * different brick/area/region than the rollup row summarising it.
 *
 * The geography half exists because the re-stamp writes ONLY geography, so the three quantity
 * measures are invariant under it: comparing them alone proves the one thing the sync cannot
 * change. On 2026-08-31 that blind proof reported 11 of 12 line-periods reconciled while 4,265
 * rows sat on a brick their own rollup disagreed with.
 */
export type TerritorySyncReconciliationRow = {
  officialLine: string;
  period: string;
  rollupTotalQty: number;
  rawTotalQty: number;
  rollupEffectiveUnits: number;
  rawEffectiveUnits: number;
  rollupRowCount: number;
  rawRowCount: number;
  /** Import rows whose brick/area/region differs from the rollup row they were summarised into. */
  geoMismatchRows: number;
  /** Import rows that join to no rollup row at all — a grain group the rebuild missed entirely. */
  unrollupRows: number;
  /**
   * Whether the geography columns were actually present in the RPC response. False means the
   * database is still on the pre-2026-08-31 function, so `reconciled` below carries the old
   * quantity-only meaning and proves nothing about geography — the panel must not show it as a
   * clean bill of health.
   */
  geographyChecked: boolean;
  reconciled: boolean;
};

/**
 * The result of pressing "Sync": how many historical import rows were re-stamped to today's
 * geography, how many batches were rebuilt, and the line-by-line proof that the drilldown's
 * rollup now equals the raw source. `allReconciled` is the single headline the button reports.
 */
export type TerritorySyncReport = {
  periods: string[];
  restampedRows: number;
  refreshedBatches: number;
  reconciliation: TerritorySyncReconciliationRow[];
  allReconciled: boolean;
  durationMs: number;
  syncedAt: string;
};

/** Last-sync metadata for the read-only freshness badge on the drilldown page. */
export type TerritorySyncStatus = {
  lastSyncedAt: string | null;
  /** A display name (or "the automated nightly sync" / "a colleague") — never the raw login/HR id
   *  behind the sync, per the owner's names-not-codes rule. Resolved server-side. */
  lastSyncedBy: string | null;
  lastRestampedRows: number | null;
  lastAllReconciled: boolean | null;
};

/** The lazy-loaded Tier-2 payload for exactly one Area, fetched on first expand. */
export type TerritoryAreaPayload = {
  areaCode: string;
  bricks: TerritoryBrickPharmacies[];
  /** True when the service's own brick/pharmacy summation matches the RPC's independently
   *  computed scope total (within epsilon) — the internal self-reconciliation guarantee. */
  reconciled: boolean;
  totalUnits: number;
  totalValue: number;
};

/** One area's (or region's) figure from the closing engine, over the window's published months. */
export type TerritoryClosingTotals = {
  /** The months summed — the published closings inside the window, oldest first. */
  periods: string[];
  /** area code (UPPER-cased, as the skeleton keys it) → sales value, EGP. */
  areaValues: Record<string, number>;
  /** region code (UPPER-cased) → sales value, EGP — that region's areas in the tree PLUS its areas
   *  without a target ("Other" areas, which the tree has no lane for), so it equals the closing's
   *  region figure. Other areas are added only for a region or nationwide viewer. */
  regionValues: Record<string, number>;
  /** region code → the part of regionValues that sits in Other areas (0 when none). */
  regionOtherValues: Record<string, number>;
  /** Nationwide viewers only: Other areas in no region the tree draws (the "Others" region), so the
   *  overall figure equals the line's published closing. null for a scoped viewer. */
  outsideRegionsValue: number | null;
};
