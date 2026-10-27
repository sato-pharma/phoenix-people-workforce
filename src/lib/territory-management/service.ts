import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { todayInCairo } from "@/lib/date-only";
import { canonicalizeRegionName, resolveSalesAccessScope } from "@/lib/sales/access-scope";
import { loadSalesReferenceData } from "@/lib/sales/monthly-distributor-import";
import { haversineKm } from "@/lib/sales/normalizer/geo-validate";
import { resolveRegionalManagerRegionCodes } from "@/lib/sales/portal-sos-dashboard";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { ilikeAnyFilter } from "@/lib/supabase/search-filter";

// Territory Management — geographic view of how a line's bricks are allocated across its areas.
//
// Two questions this answers:
//   1. Is an area's brick allocation sensible, or is there a gap / mis-assignment?
//   2. Where should a Medical Rep hired for this area live, to actually reach the bricks?
//
// SCOPING IS PER LINE. The same geography is worked by a different rep per line, so an area's
// allocation only means something in the context of one line. Area membership therefore comes
// from au_v_line_area_map (carries_target = true), the same organogram-derived source the
// Territory & Sales Drilldown uses — never raw source_of_sales_areas, which has no line concept.
//
// COORDINATE HONESTY: a brick with no trustworthy coordinate is NEVER silently dropped. On a map
// a missing pin is indistinguishable from an unallocated brick, which would invent gaps that
// don't exist and hide ones that do. Unlocated bricks are returned separately and surfaced.

const PAGE = 1000;

export type TerritoryLine = { lineCode: string; lineName: string };
export type TerritoryRegion = { areaCount: number; regionCode: string; regionName: string };
export type TerritoryArea = { areaCode: string; areaName: string; regionCode: string; regionName: string };

export type TerritoryFilters = {
  lines: TerritoryLine[];
  regions: TerritoryRegion[];
  areas: TerritoryArea[];
};

export type LatLng = { lat: number; lng: number };

export type TerritoryBrick = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  brickId: string;
  brickName: string;
  /** How trustworthy this pin is, and whether a person confirmed it. */
  confidence: { label: string; percent: number; verified: boolean };
  lat: number;
  lng: number;
  regionCode: string;
  regionName: string;
};

export type UnlocatedBrick = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  brickId: string;
  brickName: string;
  /**
   * 'missing'         — never geocoded.
   * 'wrong-region'    — geocoded into a governorate that is not the brick's own.
   * 'shared-fallback' — the geocoder returned a city/governorate centre it had already used for
   *                     other bricks. One pin carried up to 16 bricks, so the coordinate locates
   *                     nothing. Treated as no-location rather than shown as a real position.
   */
  reason: "missing" | "shared-fallback" | "wrong-region";
};

export type MstEdge = { fromBrickId: string; km: number; toBrickId: string };

export type OrphanBrick = { brickId: string; brickName: string; kmFromCentre: number };

export type OverlapBrick = {
  brickId: string;
  brickName: string;
  kmToOwnCentre: number;
  kmToOtherCentre: number;
  nearerAreaCode: string;
  nearerAreaName: string;
};

export type AreaCluster = {
  areaCode: string;
  areaName: string;
  /** Median latitude and median longitude of the area's located bricks — see medianCentre. */
  centre: LatLng | null;
  hull: LatLng[];
  locatedCount: number;
  /** Total minimum-spanning-tree length — the honest "cost to cover this area" in km. */
  mstEdges: MstEdge[];
  mstKm: number | null;
  /** Widest distance between any two bricks in the area. */
  spreadKm: number | null;
  meanPairKm: number | null;
  /** Half the area's located bricks sit within this distance of its centre. */
  medianKmFromCentre: number | null;
  orphans: OrphanBrick[];
  overlaps: OverlapBrick[];
  totalCount: number;
};

export type TerritoryMap = {
  areas: AreaCluster[];
  bricks: TerritoryBrick[];
  coverage: { located: number; missing: number; sharedFallback: number; total: number; wrongRegion: number };
  residence: ResidenceRecommendation[];
  unlocated: UnlocatedBrick[];
};

type Row = Record<string, unknown>;

async function pageAll<T>(fetcher: (from: number, to: number) => Promise<T[] | null>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = await fetcher(from, from + PAGE - 1);
    if (!rows || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/** Field lines only — Head Office carries no territory. */
const LINE_LABELS: Record<string, string> = {
  anti_infective: "Anti Infective",
  cns: "CNS",
  pedia: "Pedia",
};

/**
 * Areas a line actually carries, from the organogram seat model. `carries_target = true` and an
 * open effective window mean "this line owns this area right now".
 */
async function loadLineAreaRows(lineCode: string): Promise<Row[]> {
  return pageAll<Row>(async (from, to) => {
    const { data, error } = await getSupabaseAdmin()
      .from("au_v_line_area_map")
      .select("line_code, area_code, area_name, operational_region_code, carries_target, effective_to")
      .eq("line_code", lineCode)
      .eq("carries_target", true)
      .is("effective_to", null)
      .range(from, to);
    return error ? null : (data as Row[] | null);
  });
}

/**
 * "Others" is a holding bucket for retired, overseas and non-field territory rather than somewhere
 * a rep is ever hired to cover. Its bricks are also the sparsest and least reliably geocoded, so
 * offering it here would invite allocation analysis on areas nobody actually works.
 */
const EXCLUDED_REGION_CODE = "OT";

/**
 * The employee-portal-shell roles that reach this module at /employee-portals/territory-management.
 *
 * Single source of truth for three call sites that previously each hardcoded the list (or forgot to):
 * the portal page's own gate, the admin page's portal-mode redirect target, and the
 * `showTerritoryManagementTab` sidebar flag in src/lib/employee-portal/navigation.ts. Medical Rep is
 * deliberately absent: this module compares MULTIPLE areas' bricks against each other, which is a
 * District-Manager-and-up decision, not a single rep's own-area view. The Head-Office "Manager" rung
 * is absent too — it owns no field areas, so resolveTerritoryScope would fail it closed to nothing.
 */
export const PORTAL_TERRITORY_MANAGEMENT_ROLES = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
] as const satisfies readonly PhoenixRole[];

const portalTerritoryManagementRoleSet = new Set<PhoenixRole>(PORTAL_TERRITORY_MANAGEMENT_ROLES);

export function isPortalTerritoryManagementRole(role: PhoenixRole | string | null | undefined): boolean {
  return portalTerritoryManagementRoleSet.has(String(role ?? "").trim() as PhoenixRole);
}

export type TerritoryScope = {
  /** null = every field line is visible (CEO / SFE Manager / Super Admin: company-wide). */
  lineCodes: Set<string> | null;
  /** null = every region within the allowed lines is visible. */
  regionCodes: Set<string> | null;
  /**
   * Seat-derived area bound (organogram truth). When set it REPLACES the region narrowing:
   * a DM's areas can legitimately sit outside his region label (CNS D16 under the Alex DM),
   * and the label's region would both lose those and leak the sibling DM's areas.
   */
  areaCodes: Set<string> | null;
};

/**
 * UE-split bridge for the label-derived fallback only: the scope's region codes come from the
 * SoS vocabulary, where Upper Egypt can be the coarse "UE", but `operational_region_code` uses
 * the split children ("UE-1"/"UE-2") for the lines that divide it. A coarse code must match its
 * split children or the whole Upper Egypt team disappears from a UE-scoped manager.
 */
export function expandRegionCodesForOperationalMatch(
  codes: Set<string>,
  knownRegionCodes: Iterable<string>,
): Set<string> {
  // Expand from a FIXED base rather than the set being written to. With a plain prefix rule the
  // two agree (anything under "UE-1-" is also under "UE-"), but a Set visits elements added
  // mid-iteration, so reading off the growing set would start cascading the moment the matching
  // rule stops being a simple prefix.
  const base = [...codes].map((code) => String(code ?? "").trim().toUpperCase()).filter(Boolean);
  const expanded = new Set(base);
  for (const known of knownRegionCodes) {
    const upper = String(known ?? "").trim().toUpperCase();
    if (!upper) continue;
    if (base.some((code) => upper.startsWith(`${code}-`))) expanded.add(upper);
  }
  return expanded;
}

/**
 * Which lines and regions the caller may see, reusing the same scope machinery already proven out
 * by the Territory & Sales Drilldown (src/lib/sales/territory/root-scope.ts) rather than a second,
 * parallel notion of "scope". District Manager and Regional Manager are narrowed to their own
 * region; National Sales Manager to their own line (every region within it); CEO, SFE Manager and
 * Super Admin see everything. A role this cannot place at all (e.g. Medical Rep, who has no area-
 * management use for this module) fails closed to "nothing" rather than defaulting open.
 */
type TerritoryReferenceData = Awaited<ReturnType<typeof loadSalesReferenceData>>;

/**
 * Same resolution as {@link resolveTerritoryScope}, plus the reference-data load it makes along
 * the way (or null on the branches that never need one). Callers that go on to build a
 * region-name map from the same reference data — loadTerritoryFilters, loadTerritoryMap — reuse
 * this instead of re-fetching, which used to double `loadSalesReferenceData`'s 6-query fan-out on
 * every call (and up to 6x it on loadTerritoryScopeOverview, which resolves scope per line).
 */
/**
 * Roles that see the whole map without holding a SALES scope at all.
 *
 * Everything below this line asks `resolveSalesAccessScope`, and that answers `NONE` for any role
 * outside the sales ladder — which resolves to EMPTY line/region/area sets, not to "everything".
 * That fail-closed default is right for a rep and wrong here: the HR Business Partner holds
 * `territory:read` (owner, 2026-09-07) and has no line, no region and no seat, so without this
 * branch her map renders blank — a page that looks broken rather than refused, which is the worst
 * of the three outcomes.
 *
 * Company-wide is also the only bound that means anything for her: she sources for vacancies on
 * every line, and the module's residence recommendation is what she reads it for. Read-only is
 * enforced elsewhere and separately — `canEditPins` and `canPublishPreview` are Super Admin, and
 * the pin/preview routes assert `sales:import` / `sales:export`, neither of which she holds.
 */
// EMPTY since the owner retired the HR Business Partner seat on 2026-10-08 — she was its only member. The branch stays for the next
// non-sales seat given territory:read, so its map renders whole rather than blank.
const TERRITORY_COMPANY_WIDE_NON_SALES_ROLES = new Set<PhoenixRole>([]);

async function resolveTerritoryScopeWithReferences(
  access: AccessContext,
): Promise<{ references: TerritoryReferenceData | null; scope: TerritoryScope }> {
  if (TERRITORY_COMPANY_WIDE_NON_SALES_ROLES.has(access.role)) {
    return { references: null, scope: { lineCodes: null, regionCodes: null, areaCodes: null } };
  }

  const salesScope = await resolveSalesAccessScope(access);
  if (salesScope.canViewAllSales) {
    return { references: null, scope: { lineCodes: null, regionCodes: null, areaCodes: null } };
  }

  const lineCodes = salesScope.allowedLineNames
    ? new Set(
        Object.entries(LINE_LABELS)
          .filter(([, name]) =>
            [...salesScope.allowedLineNames as Set<string>].some(
              (allowed) => allowed.trim().toLowerCase() === name.trim().toLowerCase(),
            ))
          .map(([code]) => code),
      )
    : null;

  // The seat model answered: bound by the manager's own areas and skip region narrowing
  // entirely — the area set is strictly more precise, and comparing label-derived SoS region
  // codes against `operational_region_code` is exactly the vocabulary mismatch that dropped
  // out-of-label areas before.
  const seatAreaCodes = new Set(
    [...(salesScope.allowedAreaCodes ?? [])].map((code) => code.trim().toUpperCase()).filter(Boolean),
  );
  if (seatAreaCodes.size > 0) {
    return { references: null, scope: { lineCodes, regionCodes: null, areaCodes: seatAreaCodes } };
  }

  // National Sales Manager: LINE scope, allowedRegionNames is null — every region within the line.
  if (access.role !== "Regional Manager" && !salesScope.allowedRegionNames) {
    return { references: null, scope: { lineCodes, regionCodes: null, areaCodes: null } };
  }

  const references = await loadSalesReferenceData({ includeCustomerBricks: false });
  const knownRegionCodes = references.regions.map((region) => region.regionCode);

  // Regional Manager's real coverage (their own region plus any they stand in for) is richer than
  // the single canonical name computeSalesAccessScope derives, so use the dedicated resolver —
  // the same one root-scope.ts relies on for the Drilldown module.
  if (access.role === "Regional Manager") {
    const regionCodes = await resolveRegionalManagerRegionCodes(access, salesScope, references);
    return {
      references,
      scope: {
        lineCodes,
        regionCodes: expandRegionCodesForOperationalMatch(regionCodes, knownRegionCodes),
        areaCodes: null,
      },
    };
  }

  const codeByCanonicalName = new Map(
    references.regions.map((region) => [canonicalizeRegionName(region.regionName), region.regionCode.toUpperCase()]),
  );
  const regionCodes = new Set(
    [...(salesScope.allowedRegionNames as Set<string>)]
      .map((name) => codeByCanonicalName.get(canonicalizeRegionName(name)))
      .filter((code): code is string => Boolean(code)),
  );
  return {
    references,
    scope: {
      lineCodes,
      regionCodes: expandRegionCodesForOperationalMatch(regionCodes, knownRegionCodes),
      areaCodes: null,
    },
  };
}

export async function resolveTerritoryScope(access: AccessContext): Promise<TerritoryScope> {
  return (await resolveTerritoryScopeWithReferences(access)).scope;
}

/** One line's view of an area, as the organogram has it right now. */
export type LineArea = { areaName: string; regionCode: string };

/**
 * The areas of one line a caller may actually see — ONE definition, used by both the area picker
 * and the brick search, so the search can never hand back a brick the picker would not have
 * offered. Three narrowings: the "Others" holding bucket, the seat-derived area bound, then the
 * region label. Keyed by area code, first row wins.
 */
export function visibleLineAreas(rows: Iterable<Record<string, unknown>>, scope: TerritoryScope): Map<string, LineArea> {
  const areas = new Map<string, LineArea>();
  for (const row of rows) {
    const areaCode = str(row.area_code);
    if (!areaCode || areas.has(areaCode)) continue;
    const regionCode = str(row.operational_region_code);
    if (regionCode === EXCLUDED_REGION_CODE) continue;
    if (scope.areaCodes && !scope.areaCodes.has(areaCode.toUpperCase())) continue;
    if (scope.regionCodes && !scope.regionCodes.has(regionCode.toUpperCase())) continue;
    areas.set(areaCode, { areaName: str(row.area_name) || areaCode, regionCode });
  }
  return areas;
}

export async function loadTerritoryFilters(lineCode: string | null, access?: AccessContext): Promise<TerritoryFilters> {
  const { scope, references } = access
    ? await resolveTerritoryScopeWithReferences(access)
    : { references: null, scope: { lineCodes: null, regionCodes: null, areaCodes: null } };

  const lines = Object.entries(LINE_LABELS)
    .filter(([code]) => !scope.lineCodes || scope.lineCodes.has(code))
    .map(([code, name]) => ({ lineCode: code, lineName: name }));

  if (!lineCode || !LINE_LABELS[lineCode]) return { areas: [], lines, regions: [] };
  // A line outside the caller's own scope is refused even if it was passed in explicitly — the
  // dropdown never offers it, but a hand-crafted request must not be able to read it either.
  if (scope.lineCodes && !scope.lineCodes.has(lineCode)) return { areas: [], lines, regions: [] };

  // Reuse the reference data resolveTerritoryScopeWithReferences already loaded when it has some
  // (Regional/District Manager and named-region roles); only the roles whose scope never needed
  // it (CEO/SFE/Super Admin, National Sales Manager, seat-bound roles) fetch here.
  const regionNameByCode = new Map(
    (references ?? (await loadSalesReferenceData({ includeCustomerBricks: false }))).regions.map((r) => [
      r.regionCode.toUpperCase(),
      r.regionName,
    ]),
  );

  const areas: TerritoryArea[] = [...visibleLineAreas(await loadLineAreaRows(lineCode), scope)].map(
    ([areaCode, area]) => ({
      areaCode,
      areaName: area.areaName,
      regionCode: area.regionCode,
      regionName: regionNameByCode.get(area.regionCode.toUpperCase()) || area.regionCode,
    }),
  );
  areas.sort((a, b) => a.areaCode.localeCompare(b.areaCode));

  const regionCounts = new Map<string, number>();
  for (const area of areas) {
    if (!area.regionCode) continue;
    regionCounts.set(area.regionCode, (regionCounts.get(area.regionCode) ?? 0) + 1);
  }
  const regions = [...regionCounts.entries()]
    .map(([regionCode, areaCount]) => ({ areaCount, regionCode, regionName: regionNameByCode.get(regionCode.toUpperCase()) || regionCode }))
    .sort((a, b) => a.regionCode.localeCompare(b.regionCode));

  return { areas, lines, regions };
}

export type ScopeOverviewArea = { areaCode: string; areaName: string; brickCount: number };
export type ScopeOverviewRegion = { areas: ScopeOverviewArea[]; regionCode: string; regionName: string };
export type ScopeOverviewLine = { lineCode: string; lineName: string; regions: ScopeOverviewRegion[] };

/**
 * The caller's own scope — every line, region, area and brick count they can see — as a
 * hierarchy, meant to orient someone the moment they open the module: "this is your patch,"
 * before they pick anything. Deliberately separate from loadTerritoryFilters (which is scoped to
 * ONE chosen line): this covers every line the caller has, since the point is to show the whole
 * shape of their scope at a glance, not force picking a line first just to see it.
 */
export async function loadTerritoryScopeOverview(access: AccessContext): Promise<ScopeOverviewLine[]> {
  const filtersPerLine = await Promise.all(
    Object.keys(LINE_LABELS).map((lineCode) => loadTerritoryFilters(lineCode, access)),
  );

  const allAreaIds = new Set<string>();
  for (const filters of filtersPerLine) for (const area of filters.areas) allAreaIds.add(area.areaCode);
  const brickCountByArea = new Map<string, number>();
  if (allAreaIds.size > 0) {
    const rows = await pageAll<Row>(async (from, to) => {
      const { data, error } = await getSupabaseAdmin()
        .from("source_of_sales_bricks")
        .select("area_code")
        .in("area_code", [...allAreaIds])
        .eq("active", true)
        .is("superseded_by_brick_id", null)
        .or(brickInForceFilter(todayInCairo()))
        .range(from, to);
      return error ? null : (data as Row[] | null);
    });
    for (const row of rows) {
      const code = str(row.area_code);
      brickCountByArea.set(code, (brickCountByArea.get(code) ?? 0) + 1);
    }
  }

  const out: ScopeOverviewLine[] = [];
  const lineNamesByCode = Object.fromEntries(
    Object.entries(LINE_LABELS).map(([code, name]) => [code, name] as const),
  );
  Object.keys(LINE_LABELS).forEach((lineCode, i) => {
    const filters = filtersPerLine[i];
    if (filters.areas.length === 0) return; // this line is out of scope entirely — omit it, don't show an empty branch
    const byRegion = new Map<string, ScopeOverviewRegion>();
    for (const area of filters.areas) {
      let region = byRegion.get(area.regionCode);
      if (!region) {
        region = { areas: [], regionCode: area.regionCode, regionName: area.regionName };
        byRegion.set(area.regionCode, region);
      }
      region.areas.push({ areaCode: area.areaCode, areaName: area.areaName, brickCount: brickCountByArea.get(area.areaCode) ?? 0 });
    }
    const regions = [...byRegion.values()].sort((a, b) => a.regionName.localeCompare(b.regionName));
    for (const region of regions) region.areas.sort((a, b) => a.areaName.localeCompare(b.areaName));
    out.push({ lineCode, lineName: lineNamesByCode[lineCode], regions });
  });
  return out;
}

// ── geometry ────────────────────────────────────────────────────────────────
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * An area's centre: the median latitude and the median longitude of its located bricks.
 *
 * The mean it replaced was dragged by the very bricks the map exists to find. Measured on
 * production 2026-10-27, Qena 1: one brick sitting 57 km east (قريه الكلاحين, on its check-in GPS
 * pin) pulled the mean 12 km toward itself, so it measured only 46 km out — inside the old orphan
 * cut, while the cut itself was inflated by that brick's own long pairs. The median stays with the
 * area; it moves only when half the area does.
 */
export function medianCentre(points: LatLng[]): LatLng | null {
  const lat = median(points.map((p) => p.lat));
  const lng = median(points.map((p) => p.lng));
  return lat == null || lng == null ? null : { lat, lng };
}

/** Where an area sits, and which of its bricks do not sit with it. */
export type AreaGeography = {
  centre: LatLng | null;
  /** Half the area's located bricks sit within this distance of its centre. */
  medianKmFromCentre: number | null;
  orphans: OrphanBrick[];
  overlaps: OverlapBrick[];
};

type LocatedBrick = Pick<TerritoryBrick, "areaCode" | "brickId" | "brickName" | "lat" | "lng">;

/** Fewer located bricks than this and an area has no "rest" for one of them to be far from. */
const ORPHAN_MIN_BRICKS = 3;
const ORPHAN_SPREAD_MULTIPLE = 3;
const ORPHAN_FLOOR_KM = 12;
const OVERLAP_SPREAD_MULTIPLE = 2;
const OVERLAP_FLOOR_KM = 5;

function roundKm(km: number): number {
  return Math.round(km * 10) / 10;
}

/**
 * Every area's centre, and the bricks that look allocated to the wrong one. Pass EVERY located
 * brick of the line the viewer may see, not only the areas on screen: "closer to another area" is
 * a question about the whole line, and asked of the selection alone it had no answer whenever one
 * area was picked — the commonest way the map is read.
 *
 * Both thresholds are relative to the area's own spread — the median distance of its bricks from
 * its centre — because a Cairo district and an Upper Egypt area are not comparable on a fixed km
 * rule. They only differ in what they need to be sure of:
 *   • Orphan  — more than 3× that spread (and 12 km) from its own centre.
 *   • Overlap — nearer another area's centre than its own, AND more than 2× that spread (and 5 km)
 *               out. "Nearer" alone flagged 137 of 546 located bricks on one line on production: on a border,
 *               half of every area is nearer the neighbour's centre than its own, and that is
 *               geometry, not a mis-allocation.
 */
export function areaGeography(located: LocatedBrick[], areaNames: Map<string, string>): Map<string, AreaGeography> {
  const byArea = new Map<string, LocatedBrick[]>();
  for (const brick of located) {
    if (!Number.isFinite(brick.lat) || !Number.isFinite(brick.lng)) continue;
    const list = byArea.get(brick.areaCode);
    if (list) list.push(brick);
    else byArea.set(brick.areaCode, [brick]);
  }
  const centres = new Map<string, LatLng>();
  for (const [areaCode, list] of byArea) {
    const centre = medianCentre(list);
    if (centre) centres.set(areaCode, centre);
  }

  const out = new Map<string, AreaGeography>();
  for (const [areaCode, list] of byArea) {
    const centre = centres.get(areaCode) ?? null;
    if (!centre) continue;
    const own = list.map((brick) => haversineKm(brick.lat, brick.lng, centre.lat, centre.lng));
    const typical = median(own) ?? 0;
    const orphanCut = list.length >= ORPHAN_MIN_BRICKS ? Math.max(typical * ORPHAN_SPREAD_MULTIPLE, ORPHAN_FLOOR_KM) : null;
    const overlapCut = Math.max(typical * OVERLAP_SPREAD_MULTIPLE, OVERLAP_FLOOR_KM);
    const orphans: OrphanBrick[] = [];
    const overlaps: OverlapBrick[] = [];

    list.forEach((brick, i) => {
      if (orphanCut != null && own[i] > orphanCut) {
        orphans.push({ brickId: brick.brickId, brickName: brick.brickName, kmFromCentre: roundKm(own[i]) });
      }
      if (own[i] <= overlapCut) return;
      let nearer: { areaCode: string; km: number } | null = null;
      for (const [otherCode, otherCentre] of centres) {
        if (otherCode === areaCode) continue;
        const km = haversineKm(brick.lat, brick.lng, otherCentre.lat, otherCentre.lng);
        if (km < own[i] && (!nearer || km < nearer.km)) nearer = { areaCode: otherCode, km };
      }
      if (nearer) {
        overlaps.push({
          brickId: brick.brickId,
          brickName: brick.brickName,
          kmToOtherCentre: roundKm(nearer.km),
          kmToOwnCentre: roundKm(own[i]),
          nearerAreaCode: nearer.areaCode,
          nearerAreaName: areaNames.get(nearer.areaCode) ?? nearer.areaCode,
        });
      }
    });

    orphans.sort((a, b) => b.kmFromCentre - a.kmFromCentre);
    overlaps.sort((a, b) => a.kmToOtherCentre - a.kmToOwnCentre - (b.kmToOtherCentre - b.kmToOwnCentre));
    out.set(areaCode, { centre, medianKmFromCentre: roundKm(typical), orphans, overlaps });
  }
  return out;
}

/**
 * How far a Medical Rep can reasonably reach and return from in a working day. Used only to
 * describe an option ("covers 9 of 11 bricks"), never to disqualify one.
 */
const DAILY_REACH_KM = 40;

export type ResidenceOption = {
  averageKm: number;
  brickId: string;
  brickName: string;
  farthestBrickName: string;
  farthestKm: number;
  lat: number;
  lng: number;
  /** Ranked, human-readable justification — why this beat the alternatives. */
  reasons: string[];
  /** Total distance to every brick in the area. This is the quantity being minimised. */
  totalKm: number;
  withinReach: number;
};

export type ResidenceRecommendation = {
  areaCode: string;
  areaName: string;
  consideredBricks: number;
  /** Bricks left out because their pin is town-level only — stated, never silently dropped. */
  excludedBricks: number;
  options: ResidenceOption[];
  warning: string | null;
};

/**
 * Where should a rep hired for this area live?
 *
 * This is the 1-median problem: find the point minimising TOTAL travel to every brick. Two
 * deliberate choices:
 *
 *  - Candidates are the area's own bricks, not the free-floating geometric optimum. The true
 *    1-median frequently lands in farmland or the middle of a lake; a rep has to live somewhere
 *    that exists. Every brick is a real populated place, so scoring bricks against each other
 *    gives an answer that can actually be acted on.
 *  - Total distance is minimised rather than the worst single trip. Minimising the worst trip
 *    optimises for the rare bad day; minimising the total optimises for every ordinary one, which
 *    is what actually determines how many calls a rep can make in a week.
 *
 * Only bricks with a trustworthy pin take part. A brick sitting on a shared town centre would drag
 * the answer toward that town for no real reason, so it is excluded and reported.
 */
export function recommendResidence(
  areaCode: string,
  areaName: string,
  bricks: TerritoryBrick[],
  excludedBricks = 0,
): ResidenceRecommendation | null {
  const usable = bricks.filter((b) => b.areaCode === areaCode && Number.isFinite(b.lat) && Number.isFinite(b.lng));
  if (usable.length === 0) return null;

  if (usable.length === 1) {
    const only = usable[0];
    return {
      areaCode,
      areaName,
      consideredBricks: 1,
      excludedBricks,
      options: [{
        averageKm: 0,
        brickId: only.brickId,
        brickName: only.brickName,
        farthestBrickName: only.brickName,
        farthestKm: 0,
        lat: only.lat,
        lng: only.lng,
        reasons: [`${only.brickName} is the only brick in this area with a confirmed location.`],
        totalKm: 0,
        withinReach: 1,
      }],
      warning: excludedBricks > 0
        ? `Only one of this area's bricks has a confirmed location, so this is not a real comparison.`
        : null,
    };
  }

  const scored = usable.map((home) => {
    let totalKm = 0;
    let farthestKm = 0;
    let farthestBrickName = home.brickName;
    let withinReach = 0;
    for (const other of usable) {
      if (other.brickId === home.brickId) {
        withinReach += 1;
        continue;
      }
      const d = haversineKm(home.lat, home.lng, other.lat, other.lng);
      totalKm += d;
      if (d <= DAILY_REACH_KM) withinReach += 1;
      if (d > farthestKm) {
        farthestKm = d;
        farthestBrickName = other.brickName;
      }
    }
    return {
      averageKm: totalKm / (usable.length - 1),
      brickId: home.brickId,
      brickName: home.brickName,
      farthestBrickName,
      farthestKm,
      lat: home.lat,
      lng: home.lng,
      reasons: [] as string[],
      totalKm,
      withinReach,
    };
  }).sort((a, b) => a.totalKm - b.totalKm);

  const round = (n: number) => Math.round(n * 10) / 10;
  const best = scored[0];
  const runnerUp = scored[1];
  const worst = scored[scored.length - 1];

  best.reasons = [
    `Shortest total travel: ${round(best.totalKm)} km to reach all ${usable.length} bricks — ` +
      `${round(runnerUp.totalKm - best.totalKm)} km less than the next best (${runnerUp.brickName}) ` +
      `and ${round(worst.totalKm - best.totalKm)} km less than the worst choice (${worst.brickName}).`,
    `Average trip is ${round(best.averageKm)} km; the longest single trip is ` +
      `${round(best.farthestKm)} km, to ${best.farthestBrickName}.`,
    `${best.withinReach} of ${usable.length} bricks are within ${DAILY_REACH_KM} km — ` +
      `reachable and returnable in a working day.`,
  ];

  for (const option of scored.slice(1, 3)) {
    option.reasons = [
      `${round(option.totalKm - best.totalKm)} km more total travel than ${best.brickName}.`,
      `Longest single trip ${round(option.farthestKm)} km, to ${option.farthestBrickName}.`,
      `${option.withinReach} of ${usable.length} bricks within ${DAILY_REACH_KM} km.`,
    ];
  }

  return {
    areaCode,
    areaName,
    consideredBricks: usable.length,
    excludedBricks,
    options: scored.slice(0, 3),
    warning: excludedBricks > 0
      ? `${excludedBricks} brick${excludedBricks === 1 ? "" : "s"} in this area ` +
        `${excludedBricks === 1 ? "has" : "have"} no confirmed location and ${excludedBricks === 1 ? "was" : "were"} ` +
        `left out of this calculation.`
      : null,
  };
}

/** Andrew's monotone chain. Returns [] for fewer than 3 points (nothing to shade). */
function convexHull(points: LatLng[]): LatLng[] {
  if (points.length < 3) return [];
  const sorted = [...points].sort((a, b) => (a.lng === b.lng ? a.lat - b.lat : a.lng - b.lng));
  const cross = (o: LatLng, a: LatLng, b: LatLng) =>
    (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);

  const build = (pts: LatLng[]): LatLng[] => {
    const out: LatLng[] = [];
    for (const p of pts) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };

  const hull = [...build(sorted), ...build([...sorted].reverse())];
  return hull.length >= 3 ? hull : [];
}

/** Prim's MST over the complete graph of an area's bricks. O(n²) — fine at ~50 bricks/area. */
function minimumSpanningTree(bricks: TerritoryBrick[]): { edges: MstEdge[]; totalKm: number } {
  if (bricks.length < 2) return { edges: [], totalKm: 0 };
  const inTree = new Set<number>([0]);
  const edges: MstEdge[] = [];
  let totalKm = 0;

  while (inTree.size < bricks.length) {
    let best: { from: number; km: number; to: number } | null = null;
    for (const i of inTree) {
      for (let j = 0; j < bricks.length; j += 1) {
        if (inTree.has(j)) continue;
        const km = haversineKm(bricks[i].lat, bricks[i].lng, bricks[j].lat, bricks[j].lng);
        if (!best || km < best.km) best = { from: i, km, to: j };
      }
    }
    if (!best) break;
    inTree.add(best.to);
    totalKm += best.km;
    edges.push({
      fromBrickId: bricks[best.from].brickId,
      km: Math.round(best.km * 10) / 10,
      toBrickId: bricks[best.to].brickId,
    });
  }
  return { edges, totalKm: Math.round(totalKm * 10) / 10 };
}

function pairStats(bricks: TerritoryBrick[]): { meanKm: number | null; spreadKm: number | null } {
  if (bricks.length < 2) return { meanKm: null, spreadKm: null };
  let sum = 0;
  let max = 0;
  let count = 0;
  for (let i = 0; i < bricks.length; i += 1) {
    for (let j = i + 1; j < bricks.length; j += 1) {
      const km = haversineKm(bricks[i].lat, bricks[i].lng, bricks[j].lat, bricks[j].lng);
      sum += km;
      count += 1;
      if (km > max) max = km;
    }
  }
  return {
    meanKm: count ? Math.round((sum / count) * 10) / 10 : null,
    spreadKm: Math.round(max * 10) / 10,
  };
}

// ── shared-pin guard ────────────────────────────────────────────────────────
export type BrickPin = { lat: number; lng: number; provider: string; status: string };

/** Exact-coordinate identity. Two pins on the same point locate the same place, whatever the name. */
export function coordinateKey(lat: number, lng: number): string {
  return `${lat},${lng}`;
}

/**
 * Coordinates that more than one brick sits on, so the pin identifies none of them.
 *
 * The geocoder labels its OWN reuse `shared_fallback`, and that half was already handled. What it
 * does not label is a coordinate it happened to return twice across separate successful runs: four
 * Damietta bricks (دمياط, السراو, المنشاة, سنورس) all landed on the Damietta city point stamped
 * `success`, and بور سعيد + بورفؤاد on a second point 48.9 km from the real Port Said. Left alone
 * they draw as distinct pins at 70–85% confidence and, worse, enter the MST and the 1-median
 * residence search as zero-distance duplicates that drag the recommendation toward whichever town
 * the geocoder gave up on. Measured 2026-09-22 on production: 29 bricks over 12 coordinates.
 *
 * Only `success` pins count. One already demoted cannot make a good pin look shared.
 *
 * A pin a person placed is exempt, matching saveBrickPin's own rule: two bricks on one point is a
 * deliberate human choice, not a geocoder giving up. A coordinate is only exempt when EVERY brick
 * on it is manual — one hand-placed pin does not vouch for a geocoded one that happens to collide.
 */
export function sharedCoordinateKeys(pins: Iterable<BrickPin>): Set<string> {
  const holders = new Map<string, { manual: number; total: number }>();
  for (const pin of pins) {
    if (pin.status !== "success") continue;
    if (!Number.isFinite(pin.lat) || !Number.isFinite(pin.lng)) continue;
    const key = coordinateKey(pin.lat, pin.lng);
    const tally = holders.get(key) ?? { manual: 0, total: 0 };
    tally.total += 1;
    if (pin.provider === MANUAL_PIN_PROVIDER) tally.manual += 1;
    holders.set(key, tally);
  }
  const shared = new Set<string>();
  for (const [key, tally] of holders) {
    if (tally.total > 1 && tally.manual < tally.total) shared.add(key);
  }
  return shared;
}

// ── Bricks in force today, and the history the master keeps ────────────────
// A moved brick is never deleted or switched off: it stays `active` so closed months keep resolving
// it, and is retired by `effective_to` (its last day, inclusive — the successor starts the day
// after) plus `superseded_by_brick_id` where the move recorded one. Every brick read in this module
// used to filter on `active` alone, so each move left its husk drawn in the area it LEFT. Measured
// on production 2026-10-27: Qena 1 showed 12 bricks against the nine the owner ruled on 13 Oct —
// مدينة قنا, أبنود and قوص were drawn there at their old pins, while their successors in Qena 2 had
// no pin of their own and sat in "location unknown"; and فوه (moved to Kafr El-Sheikh 1 on 1 Aug,
// no successor recorded) was drawn in BOTH Kafr El-Sheikh areas.

/** PostgREST `or` for a brick in force on `today`: no end date, or one not yet passed. */
export function brickInForceFilter(today: string): string {
  return `effective_to.is.null,effective_to.gte.${today}`;
}

/** The complement of a brick in force: switched off, moved or merged away, or dated out. */
export function brickHistoryFilter(today: string): string {
  return `active.not.is.true,superseded_by_brick_id.not.is.null,effective_to.lt.${today}`;
}

export type BrickHistory = { brickId: string; successorId: string };

/**
 * The pin each brick in force is drawn at.
 *
 * A history brick's own pin is dropped: it is not drawn, and it must not count toward the
 * shared-pin guard either — a husk and its successor on one point is the same place, not a
 * geocoder giving up. A brick in force with no pin of its own takes the pin of a brick that moved
 * into it (a `success` one first): the move changed the area, never the ground, and nothing copies
 * the pin across when a brick is moved. A chain (A moved to B, B later to C) lands on C.
 */
export function currentBrickPins(
  pins: ReadonlyMap<string, BrickPin>,
  history: Iterable<BrickHistory>,
): Map<string, BrickPin> {
  const retired = new Set<string>();
  const moved = new Map<string, string>();
  for (const { brickId, successorId } of history) {
    retired.add(brickId);
    if (successorId && successorId !== brickId) moved.set(brickId, successorId);
  }

  const current = new Map<string, BrickPin>();
  for (const [brickId, pin] of pins) if (!retired.has(brickId)) current.set(brickId, pin);

  const inherited = new Map<string, BrickPin>();
  for (const [brickId] of moved) {
    const pin = pins.get(brickId);
    if (!pin) continue;
    let successor = brickId;
    const seen = new Set<string>();
    while (!seen.has(successor)) {
      seen.add(successor);
      const next = moved.get(successor);
      if (!next) break;
      successor = next;
    }
    if (retired.has(successor) || current.has(successor)) continue;
    const held = inherited.get(successor);
    if (!held || (held.status !== "success" && pin.status === "success")) inherited.set(successor, pin);
  }
  for (const [brickId, pin] of inherited) current.set(brickId, pin);
  return current;
}

/** Every brick the master keeps as history. A failed read answers none, as before this existed. */
async function loadBrickHistory(today: string): Promise<BrickHistory[]> {
  const rows = await pageAll<Row>(async (from, to) => {
    const { data, error } = await getSupabaseAdmin()
      .from("source_of_sales_bricks")
      .select("brick_id, superseded_by_brick_id")
      .or(brickHistoryFilter(today))
      .range(from, to);
    return error ? null : (data as Row[] | null);
  });
  return rows
    .map((row) => ({ brickId: str(row.brick_id), successorId: str(row.superseded_by_brick_id) }))
    .filter((row) => row.brickId);
}

// ── map data ────────────────────────────────────────────────────────────────
export async function loadTerritoryMap(params: {
  access?: AccessContext;
  areaCodes: string[];
  lineCode: string;
}): Promise<TerritoryMap> {
  const { access, areaCodes, lineCode } = params;
  const empty: TerritoryMap = {
    areas: [],
    bricks: [],
    coverage: { located: 0, missing: 0, sharedFallback: 0, total: 0, wrongRegion: 0 },
    residence: [],
    unlocated: [],
  };
  if (!LINE_LABELS[lineCode] || areaCodes.length === 0) return empty;

  const { scope, references } = access
    ? await resolveTerritoryScopeWithReferences(access)
    : { references: null, scope: { lineCodes: null, regionCodes: null, areaCodes: null } };
  if (scope.lineCodes && !scope.lineCodes.has(lineCode)) return empty;

  // Only areas this line actually carries — an area code from the client is never trusted. A
  // Regional/District Manager's own region further narrows this: a hand-crafted request for an
  // area code in the right line but the wrong region must not leak that region's geography either.
  const allowed = await loadLineAreaRows(lineCode);
  const areaNames = new Map<string, string>();
  // Same per-line region the filters use, so a brick never carries the line-agnostic
  // `source_of_sales_bricks.region_code`, which predates the September 2026 moves.
  const areaRegions = new Map<string, string>();
  for (const row of allowed) {
    const areaCode = str(row.area_code);
    const regionCode = str(row.operational_region_code).toUpperCase();
    if (scope.areaCodes && !scope.areaCodes.has(areaCode.toUpperCase())) continue;
    if (scope.regionCodes && !scope.regionCodes.has(regionCode)) continue;
    areaNames.set(areaCode, str(row.area_name) || areaCode);
    areaRegions.set(areaCode, str(row.operational_region_code));
  }
  const requested = areaCodes.filter((code) => areaNames.has(code));
  if (requested.length === 0) return empty;
  const wanted = new Set(requested);
  // Every area of the line this viewer may see — the same set the area picker offers — so "closer
  // to another area" is asked against the whole line, never only the areas on screen. Only the
  // requested areas are returned; the rest are read for their centres alone.
  const lineAreaCodes = [...new Set([...visibleLineAreas(allowed, scope).keys(), ...requested])];

  const regionNameByCode = new Map(
    (references ?? (await loadSalesReferenceData({ includeCustomerBricks: false }))).regions.map((r) => [
      r.regionCode.toUpperCase(),
      r.regionName,
    ]),
  );

  const today = todayInCairo();
  const brickRows = await pageAll<Row>(async (from, to) => {
    const { data, error } = await getSupabaseAdmin()
      .from("source_of_sales_bricks")
      .select("brick_id, brick_name, block_code, area_code, active")
      .in("area_code", lineAreaCodes)
      .eq("active", true)
      .is("superseded_by_brick_id", null)
      .or(brickInForceFilter(today))
      .range(from, to);
    return error ? null : (data as Row[] | null);
  });
  const requestedRows = brickRows.filter((row) => wanted.has(str(row.area_code)));
  if (requestedRows.length === 0) return empty;

  const centroidRows = await pageAll<Row>(async (from, to) => {
    const { data, error } = await getSupabaseAdmin()
      .from("geo_locations")
      .select("source_key, latitude, longitude, geocode_status, geocode_provider")
      .eq("source_type", "brick_centroid")
      .range(from, to);
    return error ? null : (data as Row[] | null);
  });
  const centroids = new Map<string, { lat: number; lng: number; provider: string; status: string }>();
  for (const row of centroidRows) {
    const key = str(row.source_key);
    if (!key || row.latitude == null || row.longitude == null) continue;
    centroids.set(key, {
      lat: Number(row.latitude),
      lng: Number(row.longitude),
      provider: str(row.geocode_provider),
      status: str(row.geocode_status),
    });
  }

  const pins = currentBrickPins(centroids, await loadBrickHistory(today));

  // Computed over EVERY brick in force, not just the selected areas' — otherwise the same brick
  // would be trusted or distrusted depending on which areas happen to be on screen, and a twin
  // sitting in an unselected area would let its partner through.
  const shared = sharedCoordinateKeys(pins.values());

  // Every area of the line is classified the same way, so a neighbour's centre is drawn from the
  // same trusted pins as the area's own; only the requested areas' bricks are returned.
  const lineBricks: TerritoryBrick[] = [];
  const lineUnlocated: UnlocatedBrick[] = [];
  for (const row of brickRows) {
    const brickId = str(row.brick_id);
    const areaCode = str(row.area_code);
    const base = {
      areaCode,
      areaName: areaNames.get(areaCode) ?? areaCode,
      blockCode: str(row.block_code),
      brickId,
      brickName: str(row.brick_name) || brickId,
    };
    const centroid = pins.get(brickId);
    if (!centroid) {
      lineUnlocated.push({ ...base, reason: "missing" });
    } else if (centroid.status !== "success") {
      lineUnlocated.push({ ...base, reason: centroid.status === "shared_fallback" ? "shared-fallback" : "wrong-region" });
    } else if (shared.has(coordinateKey(centroid.lat, centroid.lng))) {
      // Same verdict as the geocoder's own `shared_fallback`, reached a step later: the pin is real
      // but it is not THIS brick's. Reported, never drawn and never fed to the residence search.
      lineUnlocated.push({ ...base, reason: "shared-fallback" });
    } else {
      lineBricks.push({
        ...base,
        confidence: pinConfidence(centroid.provider, centroid.status),
        lat: centroid.lat,
        lng: centroid.lng,
        regionCode: areaRegions.get(areaCode) ?? "",
        regionName: regionNameByCode.get((areaRegions.get(areaCode) ?? "").toUpperCase()) || (areaRegions.get(areaCode) ?? ""),
      });
    }
  }
  const bricks = lineBricks.filter((brick) => wanted.has(brick.areaCode));
  const unlocated = lineUnlocated.filter((brick) => wanted.has(brick.areaCode));

  const byArea = new Map<string, TerritoryBrick[]>();
  for (const brick of bricks) {
    const list = byArea.get(brick.areaCode);
    if (list) list.push(brick);
    else byArea.set(brick.areaCode, [brick]);
  }
  const totalByArea = new Map<string, number>();
  for (const row of requestedRows) {
    const areaCode = str(row.area_code);
    totalByArea.set(areaCode, (totalByArea.get(areaCode) ?? 0) + 1);
  }

  const geography = areaGeography(lineBricks, areaNames);

  const areas: AreaCluster[] = [];
  for (const areaCode of requested) {
    const list = byArea.get(areaCode) ?? [];
    const geo = geography.get(areaCode);
    const { edges, totalKm } = minimumSpanningTree(list);
    const { meanKm, spreadKm } = pairStats(list);

    areas.push({
      areaCode,
      areaName: areaNames.get(areaCode) ?? areaCode,
      centre: geo?.centre ?? null,
      hull: convexHull(list.map((b) => ({ lat: b.lat, lng: b.lng }))),
      locatedCount: list.length,
      meanPairKm: meanKm,
      medianKmFromCentre: geo?.medianKmFromCentre ?? null,
      mstEdges: edges,
      mstKm: list.length >= 2 ? totalKm : null,
      orphans: geo?.orphans ?? [],
      overlaps: geo?.overlaps ?? [],
      spreadKm,
      totalCount: totalByArea.get(areaCode) ?? list.length,
    });
  }

  const unlocatedCountByArea = new Map<string, number>();
  for (const brick of unlocated) {
    unlocatedCountByArea.set(brick.areaCode, (unlocatedCountByArea.get(brick.areaCode) ?? 0) + 1);
  }
  const residence = requested
    .map((areaCode) => recommendResidence(areaCode, areaNames.get(areaCode) ?? areaCode, bricks, unlocatedCountByArea.get(areaCode) ?? 0))
    .filter((rec): rec is ResidenceRecommendation => rec !== null);

  return {
    areas,
    bricks,
    coverage: {
      located: bricks.length,
      missing: unlocated.filter((b) => b.reason === "missing").length,
      sharedFallback: unlocated.filter((b) => b.reason === "shared-fallback").length,
      total: requestedRows.length,
      wrongRegion: unlocated.filter((b) => b.reason === "wrong-region").length,
    },
    residence,
    unlocated,
  };
}

// ── Brick search + manual pin correction ────────────────────────────────────
// Geocoding gets most bricks right but cannot resolve sub-district names Google does not model
// (العصافرة بحرى vs قبلي, street-level bricks in Helwan-Maadi). Those need a human who knows the
// ground to place the pin once. A manually placed pin is authoritative: it is written with
// provider 'manual' and must never be overwritten by a later geocode run.
export const MANUAL_PIN_PROVIDER = "manual";

export type BrickSearchHit = {
  areaCode: string;
  areaName: string;
  blockCode: string;
  brickId: string;
  brickName: string;
  lat: number | null;
  lng: number | null;
  /** How the current pin was obtained — 'manual' means a person placed it. */
  provider: string | null;
  regionCode: string;
  regionName: string;
  status: string | null;
};

/**
 * Free-text brick lookup for the in-map search box. Matches Arabic or English, name or id.
 *
 * SCOPED TO THE CALLER'S OWN AREAS, through the same `visibleLineAreas` the area picker uses. The
 * box used to sweep every active brick in the country for anyone with `territory:read`, so a
 * District Manager could type two letters and read the name, area, block and exact pin of bricks
 * in a region he does not manage. Every other read in this module is scoped; this one was not.
 *
 * The region is resolved PER LINE from the organogram (`operational_region_code`), never from
 * `source_of_sales_bricks.region_code`. That column has no line concept and predates the September
 * 2026 moves, so it still reads Delta (1)/(2)/Others for every Delta (3) brick, plain "UE" for
 * every UE-1/UE-2 brick, and the old region for CNS `CA5` and `D16` — 296 bricks labelled with a
 * region their area has not been in since the moves landed.
 */
export async function searchBricks(params: {
  access?: AccessContext;
  limit?: number;
  lineCode: string;
  query: string;
}): Promise<BrickSearchHit[]> {
  const { access, limit = 20, lineCode, query } = params;
  const term = String(query ?? "").trim();
  if (term.length < 2) return [];
  if (!LINE_LABELS[lineCode]) return [];
  const searchFilter = ilikeAnyFilter(["brick_name", "brick_id"], term);
  if (!searchFilter) return [];

  // A line outside the caller's own scope is refused even when it was passed in explicitly, the
  // same way loadTerritoryFilters and loadTerritoryMap refuse it.
  const { scope, references } = access
    ? await resolveTerritoryScopeWithReferences(access)
    : { references: null, scope: { lineCodes: null, regionCodes: null, areaCodes: null } };
  if (scope.lineCodes && !scope.lineCodes.has(lineCode)) return [];

  // The caller's own areas on this line — organogram truth for the area name and the region, and
  // the BOUND on the search itself. Exactly the set the area picker offers, so a hit is always
  // somewhere they can actually go.
  const lineAreas = visibleLineAreas(await loadLineAreaRows(lineCode), scope);
  if (lineAreas.size === 0) return [];

  // In force only — a moved brick's husk would otherwise answer the search in the area it left.
  // Two `or` filters are ANDed by PostgREST: (in force) and (name or id matches).
  const today = todayInCairo();
  const { data, error } = await getSupabaseAdmin()
    .from("source_of_sales_bricks")
    .select("brick_id, brick_name, block_code, area_code")
    .eq("active", true)
    .is("superseded_by_brick_id", null)
    .or(brickInForceFilter(today))
    .in("area_code", [...lineAreas.keys()])
    .or(searchFilter)
    .limit(limit);
  if (error || !data) return [];

  const rows = data as Row[];
  const ids = rows.map((row) => str(row.brick_id)).filter(Boolean);
  let pins = new Map<string, BrickPin>();
  if (ids.length > 0) {
    // A hit with no pin of its own may take its predecessor's, the same as on the map.
    const hitIds = new Set(ids);
    const history = (await loadBrickHistory(today)).filter((row) => hitIds.has(row.successorId));
    const { data: pinRows } = await getSupabaseAdmin()
      .from("geo_locations")
      .select("source_key, latitude, longitude, geocode_status, geocode_provider")
      .eq("source_type", "brick_centroid")
      .in("source_key", [...ids, ...history.map((row) => row.brickId)]);
    const own = new Map<string, BrickPin>();
    for (const row of (pinRows ?? []) as Row[]) {
      if (row.latitude == null || row.longitude == null) continue;
      own.set(str(row.source_key), {
        lat: Number(row.latitude),
        lng: Number(row.longitude),
        provider: str(row.geocode_provider),
        status: str(row.geocode_status),
      });
    }
    pins = currentBrickPins(own, history);
  }

  const regionNameByCode = new Map(
    (references ?? (await loadSalesReferenceData({ includeCustomerBricks: false }))).regions.map((r) => [
      r.regionCode.toUpperCase(),
      r.regionName,
    ]),
  );

  return rows.map((row) => {
    const brickId = str(row.brick_id);
    const pin = pins.get(brickId);
    const areaCode = str(row.area_code);
    // Present by construction — the query is bounded by this very map.
    const area = lineAreas.get(areaCode);
    const regionCode = area?.regionCode ?? "";
    return {
      areaCode,
      areaName: area?.areaName ?? areaCode,
      blockCode: str(row.block_code),
      brickId,
      brickName: str(row.brick_name) || brickId,
      lat: pin?.lat ?? null,
      lng: pin?.lng ?? null,
      provider: pin?.provider ?? null,
      regionCode,
      regionName: regionCode ? regionNameByCode.get(regionCode.toUpperCase()) || regionCode : "",
      status: pin?.status ?? null,
    };
  });
}

/**
 * Write a hand-placed pin. Always stored as `success` + provider 'manual' — a person standing on
 * the map outranks any geocoder, and the shared-pin guard does not apply because a human placing
 * two bricks on one point is a deliberate choice, not a fallback.
 */
export async function saveBrickPin(params: {
  brickId: string;
  lat: number;
  lng: number;
  placedByHrId: string | null;
}): Promise<{ brickId: string; lat: number; lng: number }> {
  const { brickId, lat, lng, placedByHrId } = params;
  if (!brickId) throw new Error("Invalid request: brickId is required.");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Invalid request: lat/lng must be numbers.");
  // Egypt bounding box — a fat-fingered drag should not silently store a pin in another country.
  if (lat < 21.5 || lat > 32.0 || lng < 24.5 || lng > 37.0) {
    throw new Error("Invalid request: coordinates are outside Egypt.");
  }

  const { data: brick } = await getSupabaseAdmin()
    .from("source_of_sales_bricks")
    .select("brick_id, brick_name")
    .eq("brick_id", brickId)
    .maybeSingle();
  if (!brick) throw new Error("Not found: brick does not exist.");

  const { error } = await getSupabaseAdmin()
    .from("geo_locations")
    .upsert(
      {
        area: placedByHrId ? `manual:${placedByHrId}` : "manual",
        city: null,
        geocode_provider: MANUAL_PIN_PROVIDER,
        geocode_status: "success",
        label: str((brick as Row).brick_name) || brickId,
        latitude: lat,
        longitude: lng,
        source_key: brickId,
        source_type: "brick_centroid",
      },
      { onConflict: "source_type,source_key" },
    );
  if (error) throw new Error(`Failed to save pin: ${error.message}`);

  return { brickId, lat, lng };
}

// ── Pin confidence ──────────────────────────────────────────────────────────
// Every pin carries how it was obtained, so the map can say how much to trust it rather than
// presenting a guess and a verified location identically. A human placement is the only 100%:
// someone who knows the ground put it there, and no geocode may overwrite it.
export type PinConfidence = { label: string; percent: number; verified: boolean };

export function pinConfidence(provider: string | null, status: string | null): PinConfidence {
  if (status === "shared_fallback") {
    return { label: "Shared with another brick — town-level only", percent: 25, verified: false };
  }
  switch (provider) {
    case MANUAL_PIN_PROVIDER:
      return { label: "Confirmed by a person", percent: 100, verified: true };
    case "google_geocode":
      return { label: "Matched to a named district", percent: 85, verified: false };
    case "google_places_hint":
    case "google_places":
      return { label: "Matched to a named place", percent: 70, verified: false };
    case "google_block_centre":
      return { label: "Placed at its block centre — name not found", percent: 40, verified: false };
    case "google_area_centre":
      return { label: "Placed at its area centre — name not found", percent: 30, verified: false };
    // GPS a rep's phone reported is evidence of where someone stood, never of where the brick is —
    // check-ins can be spoofed (owner rule). They fell to "Unverified" at 50%, above a block centre.
    // The pins moved onto check-in GPS on 2 Aug 2026 include ones that moved AWAY from the right
    // place: احمد عرابى went from 1.4 km to 13.7 km from its area's centre, سخا from 6.1 to 16.6.
    case "checkin_gps":
      return { label: "Moved to reps' check-in GPS — not confirmed", percent: 40, verified: false };
    case "field_gps":
      return { label: "Placed at its pharmacies' field GPS — not confirmed", percent: 40, verified: false };
    default:
      return { label: "Unverified", percent: 50, verified: false };
  }
}
