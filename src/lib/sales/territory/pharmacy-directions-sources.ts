// The production read behind a drilldown pharmacy's Google Maps link (rule: pharmacy-directions.ts).
// It calls no Google service: a search link is free, and a confirmed point is Phoenix's own.
//
// ONE call to phx_territory_area_pharmacy_locations per area, run beside the pharmacy figures: it
// returns each pharmacy's distributor rows, the brick's name and centre, and every point a rep
// confirmed at that shop. Then one read of territory_pharmacy_place_matches for those customer codes:
// the Google place Phoenix matched a top pharmacy to (place id only; pharmacy-place-match.ts). A
// failure of that second read only leaves the free search links. An earlier version made about twenty follow-up reads from here and added
// 2-4 seconds to opening an area (Cairo 1 CNS, 27 Nov 2026). This read can never take the figures
// down: a failure leaves every name in the area plain text and says so in the server log.

import { isUsablePoint, type Point } from "@/lib/pharmacy-search/geo";
import { getSupabaseAdmin, toQueryError } from "@/lib/supabase/server";

import {
  pickPharmacyDirections,
  type ConfirmedPharmacyPoint,
  type MatchedPharmacyPlace,
  type PharmacySourceRow,
} from "./pharmacy-directions";
import type { TerritoryPharmacyDirections } from "./types";

type LocationRow = {
  client_code: string | null;
  distributor_code: string | null;
  client_name: string | null;
  client_address: string | null;
  brick_id: string | null;
  brick_name: string | null;
  brick_latitude: number | string | null;
  brick_longitude: number | string | null;
  confirmed_points: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : value == null ? NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The function's `[[lat, lon], …]` list, keeping only real coordinates. */
function parsePoints(value: unknown): Point[] {
  if (!Array.isArray(value)) return [];
  const points: Point[] = [];
  for (const pair of value) {
    if (!Array.isArray(pair)) continue;
    const latitude = num(pair[0]);
    const longitude = num(pair[1]);
    if (isUsablePoint(latitude, longitude)) points.push({ latitude: latitude as number, longitude: longitude as number });
  }
  return points;
}

type PlaceMatchRow = {
  distributor_code: string | null;
  client_code: string | null;
  google_place_id: string | null;
};

/** Pure: the matches table's rows → the matched places, keeping only rows with a place id. */
export function matchedPlacesFromRows(rows: readonly PlaceMatchRow[]): MatchedPharmacyPlace[] {
  const places: MatchedPharmacyPlace[] = [];
  for (const row of rows) {
    const distributorCode = text(row.distributor_code).toUpperCase();
    const clientCode = text(row.client_code);
    const placeId = text(row.google_place_id);
    if (distributorCode && clientCode && placeId) places.push({ distributorCode, clientCode, placeId });
  }
  return places;
}

/** Pure: the function's rows → customer code → where its name sends a rep. Exported for the test. */
export function directionsFromLocationRows(
  rows: readonly LocationRow[],
  matchedPlaces: readonly MatchedPharmacyPlace[] = [],
): Map<string, TerritoryPharmacyDirections> {
  const sourcesByCode = new Map<string, PharmacySourceRow[]>();
  const pointsByCode = new Map<string, ConfirmedPharmacyPoint[]>();
  const brickNames = new Map<string, string>();
  const brickCentroids = new Map<string, Point>();

  for (const row of rows) {
    const clientCode = text(row.client_code);
    const distributorCode = text(row.distributor_code).toUpperCase();
    if (!clientCode || !distributorCode) continue;
    const brickId = text(row.brick_id);
    sourcesByCode.set(clientCode, [
      ...(sourcesByCode.get(clientCode) ?? []),
      { clientCode, distributorCode, clientName: text(row.client_name) || null, clientAddress: text(row.client_address) || null, brickId },
    ]);
    const brickName = text(row.brick_name);
    if (brickId && brickName) brickNames.set(brickId, brickName);
    const latitude = num(row.brick_latitude);
    const longitude = num(row.brick_longitude);
    if (brickId && isUsablePoint(latitude, longitude)) brickCentroids.set(brickId, { latitude: latitude as number, longitude: longitude as number });
    for (const point of parsePoints(row.confirmed_points)) {
      pointsByCode.set(clientCode, [...(pointsByCode.get(clientCode) ?? []), { ...point, distributorCode, clientCode }]);
    }
  }

  const placesByCode = new Map<string, MatchedPharmacyPlace[]>();
  for (const place of matchedPlaces) {
    placesByCode.set(place.clientCode, [...(placesByCode.get(place.clientCode) ?? []), place]);
  }

  const directions = new Map<string, TerritoryPharmacyDirections>();
  for (const [code, sources] of sourcesByCode) {
    const picked = pickPharmacyDirections({
      sources,
      displayName: sources.find((source) => source.clientName)?.clientName ?? "",
      confirmedPoints: pointsByCode.get(code) ?? [],
      matchedPlaces: placesByCode.get(code) ?? [],
      brickNames,
      brickCentroids,
    });
    if (picked) directions.set(code, picked);
  }
  return directions;
}

/**
 * Customer code → where its name sends a rep, for one area's pharmacies, over the same rows and
 * months as the figures. A code with no entry gets no link. Never throws.
 */
export async function loadTerritoryPharmacyDirections(
  areaCodes: string[],
  periods: string[],
  officialLine: string,
): Promise<Map<string, TerritoryPharmacyDirections>> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc("phx_territory_area_pharmacy_locations", {
      p_area_codes: areaCodes,
      p_periods: periods,
      p_lines: [officialLine],
    });
    if (error) throw toQueryError(error);
    const rows = (data ?? []) as LocationRow[];
    return directionsFromLocationRows(rows, await loadMatchedPlaces(rows, areaCodes));
  } catch (error) {
    console.error(
      `[territory-drilldown] pharmacy directions unavailable for ${areaCodes.join(",")}: ${toQueryError(error).message}`,
    );
    return new Map();
  }
}

/** Codes per read of the matches table: keeps each request's address well under PostgREST's limit. */
const MATCH_READ_CHUNK = 200;

/** The matched Google places for these rows' customer codes. Never throws: a failure is no matches. */
async function loadMatchedPlaces(rows: readonly LocationRow[], areaCodes: string[]): Promise<MatchedPharmacyPlace[]> {
  const codes = [...new Set(rows.map((row) => text(row.client_code)).filter(Boolean))];
  if (codes.length === 0) return [];
  try {
    const chunks: string[][] = [];
    for (let index = 0; index < codes.length; index += MATCH_READ_CHUNK) chunks.push(codes.slice(index, index + MATCH_READ_CHUNK));
    const reads = await Promise.all(
      chunks.map((chunk) =>
        getSupabaseAdmin()
          .from("territory_pharmacy_place_matches")
          .select("distributor_code, client_code, google_place_id")
          .eq("status", "matched")
          .in("client_code", chunk),
      ),
    );
    const found: PlaceMatchRow[] = [];
    for (const read of reads) {
      if (read.error) throw toQueryError(read.error);
      found.push(...((read.data ?? []) as PlaceMatchRow[]));
    }
    return matchedPlacesFromRows(found);
  } catch (error) {
    console.error(`[territory-drilldown] matched Google places unavailable for ${areaCodes.join(",")}: ${toQueryError(error).message}`);
    return [];
  }
}
