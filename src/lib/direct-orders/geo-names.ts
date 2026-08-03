import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import type {
  DirectOrderCodeName,
  DirectOrderDistributorRow,
  DirectOrderPharmacy,
  DirectOrderPharmacyDistributorCode,
  DirectOrderPharmacyGeo,
} from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// Brick / area / region CODE → NAME resolution for Direct Orders.
//
// The owner's standing rule is "human-readable names, never raw codes". The report path
// has always honoured it; the approval detail and the approvals lists never did, and each
// hand-rolled its own copy of the same map-building loop. This module is the single
// implementation all of them now share — the reason the approval window printed
// "BR-1042 / CA-07" was that the resolution lived 100 lines away and was never called.
// ─────────────────────────────────────────────────────────────────────────────

export type DirectOrderGeoNameMaps = {
  brickNameById: Map<string, string>;
  areaNameByCode: Map<string, string>;
  regionNameByCode: Map<string, string>;
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; maps: DirectOrderGeoNameMaps } | null = null;

function emptyMaps(): DirectOrderGeoNameMaps {
  return { brickNameById: new Map(), areaNameByCode: new Map(), regionNameByCode: new Map() };
}

/**
 * Brick/area/region name maps from the sales reference master.
 *
 * Cached ~60s in-process. The cache is not an optimization detail — it is what keeps the
 * nav badge cheap: `countDirectOrderAwaiting` → `getDirectOrderWorkspaceData` runs on every
 * admin render, and it now needs these names for its list rows.
 *
 * Fails soft to empty maps: a reference-data outage must degrade the approval window to bare
 * codes, never break the only screen where a direct order can be approved.
 */
export async function loadDirectOrderGeoNames(): Promise<DirectOrderGeoNameMaps> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.maps;

  const maps = emptyMaps();
  try {
    const ref = await loadSalesReferenceData({ includeCustomerBricks: false });
    for (const brick of ref.bricks ?? []) {
      if (brick.brickId) maps.brickNameById.set(brick.brickId, brick.brickName);
      if (brick.areaCode) maps.areaNameByCode.set(brick.areaCode, brick.areaName);
      if (brick.regionCode) maps.regionNameByCode.set(brick.regionCode, brick.regionName);
    }
    // Areas and regions win over the brick-derived entries: they are the authoritative rows.
    for (const area of ref.areas ?? []) if (area.areaCode) maps.areaNameByCode.set(area.areaCode, area.areaName);
    for (const region of ref.regions ?? []) if (region.regionCode) maps.regionNameByCode.set(region.regionCode, region.regionName);
  } catch {
    return emptyMaps(); // do NOT cache a failure — the next call retries
  }

  cache = { at: Date.now(), maps };
  return maps;
}

/** Test seam: drop the in-process cache so a following call re-reads the master. */
export function resetDirectOrderGeoNameCache(): void {
  cache = null;
}

function pair(code: string | null | undefined, names: Map<string, string>): DirectOrderCodeName | null {
  const trimmed = (code ?? "").trim();
  if (!trimmed) return null;
  return { code: trimmed, name: names.get(trimmed) ?? "" };
}

/** Pure: a pharmacy's stored codes projected onto their names. */
export function resolveDirectOrderGeo(
  pharmacy: Pick<DirectOrderPharmacy, "brickId" | "areaCode" | "regionCode"> | null,
  maps: DirectOrderGeoNameMaps,
): DirectOrderPharmacyGeo {
  return {
    brick: pair(pharmacy?.brickId, maps.brickNameById),
    area: pair(pharmacy?.areaCode, maps.areaNameByCode),
    region: pair(pharmacy?.regionCode, maps.regionNameByCode),
  };
}

/** Pure: "Ibn Sina: 1234567; Overseas: 7654321" — the projection the report and email use. */
export function formatDistributorCodesText(codes: DirectOrderPharmacyDistributorCode[] | null | undefined): string {
  return (codes ?? []).map((code) => `${code.distributorName}: ${code.customerCode}`).join("; ");
}

/** Pure: distributor NAMES only — "Ibn Sina · Overseas". Bounded length, for list rows. */
export function formatDistributorNames(codes: DirectOrderPharmacyDistributorCode[] | null | undefined): string {
  return (codes ?? []).map((code) => code.distributorName || code.distributorCode).join(" · ");
}

/** Pure: the pairs as display rows, with each mapped brick resolved to its NAME. */
export function toDistributorRows(
  codes: DirectOrderPharmacyDistributorCode[] | null | undefined,
  maps: DirectOrderGeoNameMaps,
): DirectOrderDistributorRow[] {
  return (codes ?? []).map((code) => ({
    distributorName: code.distributorName || code.distributorCode,
    customerCode: code.customerCode,
    mappedBrickName: code.mappedBrickId
      ? maps.brickNameById.get(code.mappedBrickId) ?? code.mappedBrickId
      : null,
  }));
}

/**
 * Pure: `name (code)`, falling back to whichever half exists, then to an em dash.
 * Name FIRST — the owner reads the name; the code is the parenthetical.
 */
export function codeNameLabel(name: string | null | undefined, code: string | null | undefined): string {
  const n = (name ?? "").trim();
  const c = (code ?? "").trim();
  if (n && c) return `${n} (${c})`;
  return n || c || "—";
}
