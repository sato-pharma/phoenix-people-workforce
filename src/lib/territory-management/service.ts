import { getSupabaseAdmin } from "@/lib/supabase/server";
import { haversineKm } from "@/lib/sales/normalizer/geo-validate";

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
export type TerritoryRegion = { regionCode: string; areaCount: number };
export type TerritoryArea = { areaCode: string; areaName: string; regionCode: string };

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
  /** Geometric mean of the area's located bricks. */
  centre: LatLng | null;
  hull: LatLng[];
  locatedCount: number;
  /** Total minimum-spanning-tree length — the honest "cost to cover this area" in km. */
  mstEdges: MstEdge[];
  mstKm: number | null;
  /** Widest distance between any two bricks in the area. */
  spreadKm: number | null;
  meanPairKm: number | null;
  orphans: OrphanBrick[];
  overlaps: OverlapBrick[];
  totalCount: number;
};

export type TerritoryMap = {
  areas: AreaCluster[];
  bricks: TerritoryBrick[];
  coverage: { located: number; missing: number; sharedFallback: number; total: number; wrongRegion: number };
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

export async function loadTerritoryFilters(lineCode: string | null): Promise<TerritoryFilters> {
  const lines = Object.entries(LINE_LABELS).map(([code, name]) => ({ lineCode: code, lineName: name }));
  if (!lineCode || !LINE_LABELS[lineCode]) return { areas: [], lines, regions: [] };

  const rows = await loadLineAreaRows(lineCode);
  const areas: TerritoryArea[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const areaCode = str(row.area_code);
    if (!areaCode || seen.has(areaCode)) continue;
    seen.add(areaCode);
    areas.push({
      areaCode,
      areaName: str(row.area_name) || areaCode,
      regionCode: str(row.operational_region_code),
    });
  }
  areas.sort((a, b) => a.areaCode.localeCompare(b.areaCode));

  const regionCounts = new Map<string, number>();
  for (const area of areas) {
    if (!area.regionCode) continue;
    regionCounts.set(area.regionCode, (regionCounts.get(area.regionCode) ?? 0) + 1);
  }
  const regions = [...regionCounts.entries()]
    .map(([regionCode, areaCount]) => ({ areaCount, regionCode }))
    .sort((a, b) => a.regionCode.localeCompare(b.regionCode));

  return { areas, lines, regions };
}

// ── geometry ────────────────────────────────────────────────────────────────
function centreOf(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  const lat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p.lng, 0) / points.length;
  return { lat, lng };
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

// ── map data ────────────────────────────────────────────────────────────────
export async function loadTerritoryMap(params: {
  areaCodes: string[];
  lineCode: string;
}): Promise<TerritoryMap> {
  const { areaCodes, lineCode } = params;
  const empty: TerritoryMap = {
    areas: [],
    bricks: [],
    coverage: { located: 0, missing: 0, sharedFallback: 0, total: 0, wrongRegion: 0 },
    unlocated: [],
  };
  if (!LINE_LABELS[lineCode] || areaCodes.length === 0) return empty;

  // Only areas this line actually carries — an area code from the client is never trusted.
  const allowed = await loadLineAreaRows(lineCode);
  const areaNames = new Map<string, string>();
  for (const row of allowed) areaNames.set(str(row.area_code), str(row.area_name) || str(row.area_code));
  const requested = areaCodes.filter((code) => areaNames.has(code));
  if (requested.length === 0) return empty;

  const brickRows = await pageAll<Row>(async (from, to) => {
    const { data, error } = await getSupabaseAdmin()
      .from("source_of_sales_bricks")
      .select("brick_id, brick_name, block_code, area_code, region_code, active")
      .in("area_code", requested)
      .eq("active", true)
      .range(from, to);
    return error ? null : (data as Row[] | null);
  });
  if (brickRows.length === 0) return empty;

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

  const bricks: TerritoryBrick[] = [];
  const unlocated: UnlocatedBrick[] = [];
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
    const centroid = centroids.get(brickId);
    if (centroid && centroid.status === "success") {
      bricks.push({
        ...base,
        confidence: pinConfidence(centroid.provider, centroid.status),
        lat: centroid.lat,
        lng: centroid.lng,
        regionCode: str(row.region_code),
      });
    } else if (!centroid) {
      unlocated.push({ ...base, reason: "missing" });
    } else {
      unlocated.push({ ...base, reason: centroid.status === "shared_fallback" ? "shared-fallback" : "wrong-region" });
    }
  }

  const byArea = new Map<string, TerritoryBrick[]>();
  for (const brick of bricks) {
    const list = byArea.get(brick.areaCode);
    if (list) list.push(brick);
    else byArea.set(brick.areaCode, [brick]);
  }
  const totalByArea = new Map<string, number>();
  for (const row of brickRows) {
    const areaCode = str(row.area_code);
    totalByArea.set(areaCode, (totalByArea.get(areaCode) ?? 0) + 1);
  }

  const centres = new Map<string, LatLng | null>();
  for (const [areaCode, list] of byArea) centres.set(areaCode, centreOf(list));

  const areas: AreaCluster[] = [];
  for (const areaCode of requested) {
    const list = byArea.get(areaCode) ?? [];
    const centre = centres.get(areaCode) ?? null;
    const { edges, totalKm } = minimumSpanningTree(list);
    const { meanKm, spreadKm } = pairStats(list);

    // Orphan: sits well outside its own area's cluster. Threshold is RELATIVE to the area's own
    // mean pair distance — Cairo and Upper Egypt are not comparable on a fixed km rule.
    const orphanCut = meanKm != null ? Math.max(meanKm * 1.75, 12) : null;
    const orphans: OrphanBrick[] = [];
    const overlaps: OverlapBrick[] = [];

    for (const brick of list) {
      if (!centre) continue;
      const own = haversineKm(brick.lat, brick.lng, centre.lat, centre.lng);
      if (orphanCut != null && own > orphanCut) {
        orphans.push({ brickId: brick.brickId, brickName: brick.brickName, kmFromCentre: Math.round(own * 10) / 10 });
      }
      // Overlap: physically closer to a DIFFERENT selected area's centre than to its own. This is
      // the finding worth acting on — it usually means the brick belongs to the neighbour.
      let nearer: { areaCode: string; km: number } | null = null;
      for (const [otherCode, otherCentre] of centres) {
        if (otherCode === areaCode || !otherCentre) continue;
        const km = haversineKm(brick.lat, brick.lng, otherCentre.lat, otherCentre.lng);
        if (km < own && (!nearer || km < nearer.km)) nearer = { areaCode: otherCode, km };
      }
      if (nearer) {
        overlaps.push({
          brickId: brick.brickId,
          brickName: brick.brickName,
          kmToOtherCentre: Math.round(nearer.km * 10) / 10,
          kmToOwnCentre: Math.round(own * 10) / 10,
          nearerAreaCode: nearer.areaCode,
          nearerAreaName: areaNames.get(nearer.areaCode) ?? nearer.areaCode,
        });
      }
    }

    orphans.sort((a, b) => b.kmFromCentre - a.kmFromCentre);
    overlaps.sort((a, b) => a.kmToOtherCentre - a.kmToOwnCentre - (b.kmToOtherCentre - b.kmToOwnCentre));

    areas.push({
      areaCode,
      areaName: areaNames.get(areaCode) ?? areaCode,
      centre,
      hull: convexHull(list.map((b) => ({ lat: b.lat, lng: b.lng }))),
      locatedCount: list.length,
      meanPairKm: meanKm,
      mstEdges: edges,
      mstKm: list.length >= 2 ? totalKm : null,
      orphans,
      overlaps,
      spreadKm,
      totalCount: totalByArea.get(areaCode) ?? list.length,
    });
  }

  return {
    areas,
    bricks,
    coverage: {
      located: bricks.length,
      missing: unlocated.filter((b) => b.reason === "missing").length,
      sharedFallback: unlocated.filter((b) => b.reason === "shared-fallback").length,
      total: brickRows.length,
      wrongRegion: unlocated.filter((b) => b.reason === "wrong-region").length,
    },
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
  status: string | null;
};

/** Free-text brick lookup for the in-map search box. Matches Arabic or English, name or id. */
export async function searchBricks(query: string, limit = 20): Promise<BrickSearchHit[]> {
  const term = String(query ?? "").trim();
  if (term.length < 2) return [];

  const { data, error } = await getSupabaseAdmin()
    .from("source_of_sales_bricks")
    .select("brick_id, brick_name, block_code, area_code, region_code")
    .eq("active", true)
    .or(`brick_name.ilike.%${term}%,brick_id.ilike.%${term}%`)
    .limit(limit);
  if (error || !data) return [];

  const rows = data as Row[];
  const ids = rows.map((row) => str(row.brick_id)).filter(Boolean);
  const pins = new Map<string, { lat: number; lng: number; provider: string; status: string }>();
  if (ids.length > 0) {
    const { data: pinRows } = await getSupabaseAdmin()
      .from("geo_locations")
      .select("source_key, latitude, longitude, geocode_status, geocode_provider")
      .eq("source_type", "brick_centroid")
      .in("source_key", ids);
    for (const row of (pinRows ?? []) as Row[]) {
      if (row.latitude == null || row.longitude == null) continue;
      pins.set(str(row.source_key), {
        lat: Number(row.latitude),
        lng: Number(row.longitude),
        provider: str(row.geocode_provider),
        status: str(row.geocode_status),
      });
    }
  }

  const areaNames = new Map<string, string>();
  const { data: areaRows } = await getSupabaseAdmin()
    .from("source_of_sales_areas")
    .select("area_code, area_name");
  for (const row of (areaRows ?? []) as Row[]) areaNames.set(str(row.area_code), str(row.area_name));

  return rows.map((row) => {
    const brickId = str(row.brick_id);
    const pin = pins.get(brickId);
    const areaCode = str(row.area_code);
    return {
      areaCode,
      areaName: areaNames.get(areaCode) ?? areaCode,
      blockCode: str(row.block_code),
      brickId,
      brickName: str(row.brick_name) || brickId,
      lat: pin?.lat ?? null,
      lng: pin?.lng ?? null,
      provider: pin?.provider ?? null,
      regionCode: str(row.region_code),
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
    default:
      return { label: "Unverified", percent: 50, verified: false };
  }
}
