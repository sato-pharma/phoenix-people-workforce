/**
 * Location integrity — the mini-map that shows the difference between a case's readings.
 *
 * The owner asked to "show me live the difference in locations" (2026-10-13) and chose free
 * OpenStreetMap tiles plus the numbers over a paid map API — the same answer `geo.ts` already
 * carries ("never buy a map API").
 *
 * 🔴 THE MARKERS AND THE DISTANCES ARE OURS, SO THE PANEL IS STILL TRUE WITH NO TILES BEHIND IT.
 * This module computes geometry only: where each reading sits in the frame, which tiles cover that
 * frame, and how far apart every pair is. The view draws square markers and a leader line on top.
 * If a tile never loads — a blocked host, a dead connection, a tile server refusing — the readings
 * and every metre figure are unchanged and the caption says the streets are missing. That is the
 * rule `src/lib/field-activity/map.ts` has carried since the route map lost its basemap for weeks,
 * and it is the reason the numbers are never left to the picture.
 *
 * Web Mercator is written out here rather than imported from that sibling: its `project` is private,
 * its `fitZoom` takes a route point, and the file reaches for `Buffer` to fetch a basemap on the
 * server — which this one must never do, because it runs in the reader's own browser.
 */

import { distanceMeters, formatDistance, type GeoPoint } from "@/lib/phoenix-crm/geo";

/** The tile scheme OpenStreetMap uses: 256-pixel tiles, zoom 0 to 19. */
const TILE_SIZE = 256;
const MAX_ZOOM = 18;
const MIN_ZOOM = 3;

/** Where the tiles come from, and the attribution that must travel with them. */
export const OSM_TILE_HOST = "https://tile.openstreetmap.org";
export const OSM_ATTRIBUTION = "Map data © OpenStreetMap contributors";

export type CaseMapPoint = GeoPoint & {
  label: string;
  accuracyMeters: number | null;
};

export type CaseMapTile = {
  /** Stable across renders, so a redraw does not refetch a tile the browser already holds. */
  key: string;
  url: string;
  left: number;
  top: number;
  size: number;
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
  tiles: CaseMapTile[];
  markers: CaseMapMarker[];
  /** Every pair of readings, widest apart first. */
  pairs: CaseMapPair[];
  /** The metres between the two readings furthest apart; null when there is only one. */
  spreadMeters: number | null;
  attribution: string;
};

/** Web-Mercator pixel at a zoom, in the 256-tile scheme OpenStreetMap uses. */
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
 * The whole map for one case: the tiles that cover the frame, each reading's position in it, and
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

  const width = Math.max(options.width ?? 320, TILE_SIZE);
  const height = Math.max(options.height ?? 240, TILE_SIZE);
  const zoom = fitZoom(usable, width, height, options.padding ?? 48);
  const centre = centreOf(usable);

  // The frame, in world pixels at this zoom. Everything below is an offset inside it.
  const centrePixel = project(centre.lon, centre.lat, zoom);
  const originX = centrePixel.x - width / 2;
  const originY = centrePixel.y - height / 2;
  const tilesAcross = 2 ** zoom;

  const tiles: CaseMapTile[] = [];
  const firstTileX = Math.floor(originX / TILE_SIZE);
  const lastTileX = Math.floor((originX + width) / TILE_SIZE);
  const firstTileY = Math.floor(originY / TILE_SIZE);
  const lastTileY = Math.floor((originY + height) / TILE_SIZE);
  for (let tileY = firstTileY; tileY <= lastTileY; tileY += 1) {
    // Past the poles there is no tile at all; the row is simply absent and the ground shows through.
    if (tileY < 0 || tileY >= tilesAcross) continue;
    for (let tileX = firstTileX; tileX <= lastTileX; tileX += 1) {
      // The world wraps east to west, so the column does — a frame straddling the date line still
      // draws, which is also the cheapest way to be sure a bad longitude cannot blank the map.
      const wrapped = ((tileX % tilesAcross) + tilesAcross) % tilesAcross;
      tiles.push({
        key: `${zoom}/${wrapped}/${tileY}`,
        url: `${OSM_TILE_HOST}/${zoom}/${wrapped}/${tileY}.png`,
        left: tileX * TILE_SIZE - originX,
        top: tileY * TILE_SIZE - originY,
        size: TILE_SIZE,
      });
    }
  }

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
    tiles,
    markers,
    pairs,
    spreadMeters: caseSpreadMeters(usable),
    attribution: OSM_ATTRIBUTION,
  };
}
