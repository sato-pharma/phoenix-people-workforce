/**
 * Location integrity — the mini-map that shows the difference between a case's readings.
 *
 * The owner asked to "show me live the difference in locations" (2026-10-13) and chose free
 * OpenStreetMap tiles plus the numbers over a paid map API. 🔴 On 13 Nov 2026 he moved the streets to
 * Google ("why do not we go to Google Maps?", then "Move it to Google Maps"): the app already holds a
 * Google server key for the route map and the outstation review map, and OpenStreetMap's own policy
 * promises nothing to a business. So the frame's streets are ONE picture from Google's Maps Static
 * API, asked of this app's own route (`CASE_MAP_BASEMAP_ROUTE`), which fetches it with the server key.
 * The key never reaches a browser, and no browser asks a map host anything. Never point a reader's
 * browser at a tile host again.
 *
 * 🔴 THE MARKERS AND THE DISTANCES ARE OURS, SO THE PANEL IS STILL TRUE WITH NO STREETS BEHIND IT.
 * This module computes geometry only: where each reading sits in the frame, the address of the
 * frame's streets, and how far apart every pair is. The view draws square markers and a leader line
 * on top. If the picture never loads — a dead connection, Google refusing the key, the hourly limit —
 * the readings and every metre figure are unchanged and the caption says the streets are missing. That is the
 * rule `src/lib/field-activity/map.ts` has carried since the route map lost its basemap for weeks,
 * and it is the reason the numbers are never left to the picture.
 *
 * Web Mercator is written out here rather than imported from that sibling: its `project` is private,
 * its `fitZoom` takes a route point, and the file reaches for `Buffer` to fetch a basemap on the
 * server — which this one must never do, because it runs in the reader's own browser.
 */

import { distanceMeters, formatDistance, type GeoPoint } from "@/lib/phoenix-crm/geo";

/** The Web-Mercator scheme every web map shares, Google's included: 256-pixel tiles, zoom 0 to 19. */
const TILE_SIZE = 256;
const MAX_ZOOM = 18;
const MIN_ZOOM = 3;

/** Where the streets come from: this app's own route, which asks Google with the server key. */
export const CASE_MAP_BASEMAP_ROUTE = "/api/admin/phoenix-crm/case-map-basemap";
/** Google prints its own mark inside the picture; this line travels with it in words. */
export const CASE_MAP_ATTRIBUTION = "Map data © Google";
/** The Maps Static API draws at most 640 pixels a side (doubled in density, never in frame). */
export const CASE_MAP_MAX_SIDE = 640;

export type CaseMapBasemapRequest = { centre: GeoPoint; zoom: number; width: number; height: number };

/** The address of one frame's streets. Six decimals is 11 cm: the frame the markers were placed in. */
export function caseMapBasemapUrl(input: CaseMapBasemapRequest): string {
  return (
    `${CASE_MAP_BASEMAP_ROUTE}?lat=${input.centre.lat.toFixed(6)}&lon=${input.centre.lon.toFixed(6)}` +
    `&zoom=${input.zoom}&w=${Math.round(input.width)}&h=${Math.round(input.height)}`
  );
}

/**
 * What the route accepts, or null. 🔴 Every picture Google draws is counted against the company's
 * account, so the route draws only a frame `buildCaseMap` could have asked for: a real coordinate, a
 * whole zoom this module uses, and a side between one tile and Google's own limit. Anything else is
 * refused before Google is asked.
 */
export function parseCaseMapBasemapQuery(params: URLSearchParams): CaseMapBasemapRequest | null {
  const read = (name: string): number | null => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const lat = read("lat");
  const lon = read("lon");
  const zoom = read("zoom");
  const width = read("w");
  const height = read("h");
  if (lat === null || lon === null || zoom === null || width === null || height === null) return null;
  if (lat < -85.06 || lat > 85.06 || lon < -180 || lon > 180) return null;
  if (!Number.isInteger(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) return null;
  for (const side of [width, height]) {
    if (!Number.isInteger(side) || side < TILE_SIZE || side > CASE_MAP_MAX_SIDE) return null;
  }
  return { centre: { lat, lon }, zoom, width, height };
}

export type CaseMapPoint = GeoPoint & {
  label: string;
  accuracyMeters: number | null;
};

export type CaseMapMarker = {
  label: string;
  /** 1, 2, 3 — what the marker shows and what the numbers beside the map refer to. */
  index: number;
  left: number;
  top: number;
  accuracyMeters: number | null;
  lat: number;
  lon: number;
  /** True when this reading sits on exactly the same point as an earlier one. */
  sharesPointWith: number | null;
};

export type CaseMapPair = {
  fromIndex: number;
  toIndex: number;
  meters: number;
  /** The whole fact in one sentence, already in the reader's words. */
  text: string;
};

export type CaseMap = {
  width: number;
  height: number;
  zoom: number;
  centre: GeoPoint;
  /** The streets behind the frame: one picture, asked of this app's own route. */
  basemapUrl: string;
  markers: CaseMapMarker[];
  /** Every pair of readings, widest apart first. */
  pairs: CaseMapPair[];
  /** The metres between the two readings furthest apart; null when there is only one. */
  spreadMeters: number | null;
  attribution: string;
};

/** Web-Mercator pixel at a zoom, in the 256-pixel scheme Google's pictures use too. */
export function project(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const size = TILE_SIZE * 2 ** zoom;
  // Clamped at the poles: `lat = ±90` sends the log to infinity, and one unusable fix would take the
  // whole frame with it.
  const bounded = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin((bounded * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

/** The largest zoom at which every reading still sits inside the frame, with room for its marker. */
export function fitZoom(points: ReadonlyArray<GeoPoint>, width: number, height: number, padding = 48): number {
  if (points.length <= 1) return 16;
  for (let zoom = MAX_ZOOM; zoom > MIN_ZOOM; zoom -= 1) {
    const xs = points.map((point) => project(point.lon, point.lat, zoom).x);
    const ys = points.map((point) => project(point.lon, point.lat, zoom).y);
    const spansWidth = Math.max(...xs) - Math.min(...xs) <= Math.max(width - 2 * padding, 1);
    const spansHeight = Math.max(...ys) - Math.min(...ys) <= Math.max(height - 2 * padding, 1);
    if (spansWidth && spansHeight) return zoom;
  }
  return MIN_ZOOM;
}

/**
 * The metres between the two readings furthest apart — the one number the "how far apart" filter
 * bands by, and the headline figure in the panel.
 *
 * Zero is a real answer and not a missing one: two readings on the same point to the bit is the
 * commonest finding on this board.
 */
export function caseSpreadMeters(points: ReadonlyArray<GeoPoint>): number | null {
  if (points.length < 2) return null;
  let widest = 0;
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      widest = Math.max(widest, distanceMeters(points[left]!, points[right]!));
    }
  }
  return widest;
}

function centreOf(points: ReadonlyArray<GeoPoint>): GeoPoint {
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  return { lat: (Math.max(...lats) + Math.min(...lats)) / 2, lon: (Math.max(...lons) + Math.min(...lons)) / 2 };
}

/**
 * The whole map for one case: the address of the streets behind the frame, each reading's position in it, and
 * every pair's distance in words.
 *
 * Null when the case has no usable reading at all — the panel then says so in words rather than
 * drawing an empty frame.
 */
export function buildCaseMap(
  points: ReadonlyArray<CaseMapPoint>,
  options: { width?: number; height?: number; padding?: number } = {},
): CaseMap | null {
  const usable = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  if (usable.length === 0) return null;

  const width = Math.min(Math.max(Math.round(options.width ?? 320), TILE_SIZE), CASE_MAP_MAX_SIDE);
  const height = Math.min(Math.max(Math.round(options.height ?? 240), TILE_SIZE), CASE_MAP_MAX_SIDE);
  const zoom = fitZoom(usable, width, height, options.padding ?? 48);
  const centre = centreOf(usable);

  // The frame, in world pixels at this zoom. Everything below is an offset inside it.
  const centrePixel = project(centre.lon, centre.lat, zoom);
  const originX = centrePixel.x - width / 2;
  const originY = centrePixel.y - height / 2;
  const markers: CaseMapMarker[] = usable.map((point, index) => {
    const pixel = project(point.lon, point.lat, zoom);
    const earlier = usable.findIndex((other) => other.lat === point.lat && other.lon === point.lon);
    return {
      label: point.label,
      index: index + 1,
      left: pixel.x - originX,
      top: pixel.y - originY,
      accuracyMeters: point.accuracyMeters,
      lat: point.lat,
      lon: point.lon,
      // 🔴 NOT DEDUPED, FLAGGED. Two markers on one pixel are the finding itself, so the view draws
      // both and says which it is sitting on — removing one would delete the evidence.
      sharesPointWith: earlier !== -1 && earlier < index ? earlier + 1 : null,
    };
  });

  // 🔴 ONE LINE PER PAIR OF DISTINCT POINTS, NOT PER PAIR OF LABELS. Three readings of which two
  // sit on one point give three pairs, and two of them carry the SAME number — which is how he was
  // sent "the pin ... are 2.8 km apart" twice over, immediately above a line saying the other two
  // are one reading. The markers stay undeduped above (that is the evidence); the sentences do not
  // repeat themselves. The zero-distance pair is kept, because naming both labels IS the finding.
  const pairs: CaseMapPair[] = [];
  const keyOf = (point: { lat: number; lon: number }): string => `${point.lat.toFixed(6)},${point.lon.toFixed(6)}`;
  const said = new Set<string>();
  for (let left = 0; left < usable.length; left += 1) {
    for (let right = left + 1; right < usable.length; right += 1) {
      const said_key = [keyOf(usable[left]!), keyOf(usable[right]!)].sort().join("|");
      if (said.has(said_key)) continue;
      said.add(said_key);
      const metres = distanceMeters(usable[left]!, usable[right]!);
      pairs.push({
        fromIndex: left + 1,
        toIndex: right + 1,
        meters: metres,
        text: metres <= 0
          ? `${usable[left]!.label} and ${usable[right]!.label.toLowerCase()} are the same reading, to the bit`
          : `${usable[left]!.label} and ${usable[right]!.label.toLowerCase()} are ${formatDistance(metres)} apart`,
      });
    }
  }
  pairs.sort((first, second) => second.meters - first.meters);

  return {
    width,
    height,
    zoom,
    centre,
    basemapUrl: caseMapBasemapUrl({ centre, zoom, width, height }),
    markers,
    pairs,
    spreadMeters: caseSpreadMeters(usable),
    attribution: CASE_MAP_ATTRIBUTION,
  };
}
