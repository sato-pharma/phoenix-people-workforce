import type { PhoenixRole } from "@/lib/auth/permissions";

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
  units: number;
  /** Per-product units for this pharmacy in this month — drives the trend tooltip
   *  (e.g. "Saginko 100 units, Royafloxacin 70 units"). Empty when hasSales is false. */
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
