/**
 * Phoenix CRM — My map's geometry, with no I/O: the Web Mercator projection the map tiles use, the frame
 * a set of pins fits in, the grid that groups pins into count tiles at a wide zoom, and the frame of the
 * landing card's drawn picture.
 *
 * 🔴 COPIED, NEVER IMPORTED, from the Super Admin's case map. That file's module path names a word the blind
 * half of this module may not carry (`tests/phoenix-crm-blind-half.test.ts` reads every string, import
 * paths included), and a rep's screen must not depend on the evidence screens' code.
 *
 * 🔴 EVERY PIN IS IN EXACTLY ONE GROUP AT EVERY ZOOM. A grid cell is a pure function of the pin's own
 * projected position, so no pin can fall between two cells or be counted in both, and the tiles' counts
 * always add up to the pins drawn (pinned by `tests/phoenix-crm-my-map.test.ts`).
 */

import type { GeoPoint } from "@/lib/phoenix-crm/geo";

const TILE_SIZE = 256;
const MAX_ZOOM = 18;
const MIN_ZOOM = 3;

/** Below this zoom the pins are grouped into count tiles; from it on, every pin is drawn on its own. */
export const MY_MAP_GROUP_BELOW_ZOOM = 13;

/** The side of one grouping cell on screen, in pixels: about one finger. */
export const MY_MAP_GROUP_CELL_PX = 64;

/** Web Mercator, in pixels of the whole world at this zoom. */
export function project(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const size = TILE_SIZE * 2 ** zoom;
  // Clamped at the poles: `lat = ±90` sends the log to infinity, and one unusable point would take the
  // whole frame with it.
  const bounded = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const sin = Math.sin((bounded * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

/** The largest whole zoom at which every point still sits inside the frame, with room for its pin. */
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

export type GeoBounds = { north: number; south: number; east: number; west: number };

/** The smallest box holding every point; null for none. */
export function boundsOf(points: ReadonlyArray<GeoPoint>): GeoBounds | null {
  if (points.length === 0) return null;
  let north = -Infinity;
  let south = Infinity;
  let east = -Infinity;
  let west = Infinity;
  for (const point of points) {
    north = Math.max(north, point.lat);
    south = Math.min(south, point.lat);
    east = Math.max(east, point.lon);
    west = Math.min(west, point.lon);
  }
  return { north, south, east, west };
}

/** Whether a point is inside a box — the list under the map follows what the map shows. */
export function insideBounds(point: GeoPoint, bounds: GeoBounds): boolean {
  return point.lat <= bounds.north && point.lat >= bounds.south && point.lon <= bounds.east && point.lon >= bounds.west;
}

export type MapGroup<T> = { lat: number; lon: number; members: T[] };

/**
 * The pins grouped for this zoom. From `MY_MAP_GROUP_BELOW_ZOOM` on, each pin is a group of one. Below it, the
 * pins are bucketed by the screen cell their own projected position falls in, and a group sits at the mean of
 * its members — never at a cell's corner, which would put a tile where no customer is.
 */
export function groupPins<T extends GeoPoint>(points: ReadonlyArray<T>, zoom: number, cellPx = MY_MAP_GROUP_CELL_PX): MapGroup<T>[] {
  if (zoom >= MY_MAP_GROUP_BELOW_ZOOM) return points.map((point) => ({ lat: point.lat, lon: point.lon, members: [point] }));
  const whole = Math.max(0, Math.floor(zoom));
  const cells = new Map<string, T[]>();
  for (const point of points) {
    const { x, y } = project(point.lon, point.lat, whole);
    const key = `${Math.floor(x / cellPx)}:${Math.floor(y / cellPx)}`;
    const members = cells.get(key);
    if (members) members.push(point);
    else cells.set(key, [point]);
  }
  const groups: MapGroup<T>[] = [];
  for (const members of cells.values()) {
    let lat = 0;
    let lon = 0;
    for (const member of members) {
      lat += member.lat;
      lon += member.lon;
    }
    groups.push({ lat: lat / members.length, lon: lon / members.length, members });
  }
  return groups;
}

/**
 * Where each point lands in a drawn picture `width` × `height`, the territory filling it with `padding` to
 * spare. A fractional scale, so a district fills the card as well as the country does; one point, or points
 * a few metres apart, are held at a street's scale instead of being blown up to fill the frame.
 */
export function snapshotFrame(
  points: ReadonlyArray<GeoPoint>,
  width: number,
  height: number,
  padding = 16,
): (point: GeoPoint) => { x: number; y: number } {
  const world = points.map((point) => project(point.lon, point.lat, 0));
  if (world.length === 0) return () => ({ x: width / 2, y: height / 2 });
  const minX = Math.min(...world.map((point) => point.x));
  const maxX = Math.max(...world.map((point) => point.x));
  const minY = Math.min(...world.map((point) => point.y));
  const maxY = Math.max(...world.map((point) => point.y));
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const streetScale = 2 ** 15;
  const fit = Math.min(
    spanX > 0 ? Math.max(width - 2 * padding, 1) / spanX : Infinity,
    spanY > 0 ? Math.max(height - 2 * padding, 1) / spanY : Infinity,
  );
  const scale = Math.min(fit, streetScale);
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  return (point) => {
    const projected = project(point.lon, point.lat, 0);
    return { x: width / 2 + (projected.x - centreX) * scale, y: height / 2 + (projected.y - centreY) * scale };
  };
}

/** Up to `most` of the points, evenly through the list — the same points every time for the same list. */
export function evenSample<T>(items: ReadonlyArray<T>, most: number): T[] {
  if (items.length <= most) return [...items];
  const step = items.length / most;
  const out: T[] = [];
  for (let index = 0; index < most; index += 1) out.push(items[Math.floor(index * step)]);
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The `most` bricks with the most pins, each labelled at the median of its OWN pins — so a label is always
 * where that brick's customers are, and no border or centroid table is needed to place it.
 */
export function brickLabels(points: ReadonlyArray<GeoPoint & { brick: string | null }>, most: number): Array<GeoPoint & { name: string; pins: number }> {
  const byBrick = new Map<string, GeoPoint[]>();
  for (const point of points) {
    const name = point.brick?.trim();
    if (!name) continue;
    const list = byBrick.get(name);
    if (list) list.push(point);
    else byBrick.set(name, [point]);
  }
  return [...byBrick.entries()]
    .sort(([leftName, left], [rightName, right]) => right.length - left.length || leftName.localeCompare(rightName))
    .slice(0, most)
    .map(([name, list]) => ({ name, pins: list.length, lat: median(list.map((point) => point.lat)), lon: median(list.map((point) => point.lon)) }));
}
