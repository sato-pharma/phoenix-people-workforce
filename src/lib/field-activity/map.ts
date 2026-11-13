/**
 * Field Activity — the day's route, as one self-contained SVG.
 *
 * WHY SVG OVER A BASEMAP RATHER THAN A MARKED-UP STATIC IMAGE. Google's Static Maps API can draw
 * its own numbered pins, but a label there is a SINGLE character — so a fourteen-stop day, which is
 * an ordinary day for a product manager out with a rep, cannot be numbered at all past nine. The
 * basemap is therefore fetched plain and every marker, leader line, route and scale bar is drawn in
 * vector on top of it. That also makes the markers SQUARE, which is the house rule, and keeps them
 * crisp at print resolution instead of resampling a raster's pins.
 *
 * NO KEY, NO FAILURE. `GOOGLE_MAPS_SERVER_KEY` is provisioned in production but absent in a local
 * checkout, and a report that throws there would be a report nobody could develop against. Without
 * a key the same SVG renders on a plain ground: the route, the numbered stops and the scale bar are
 * all still there and still true — only the streets behind them are missing, and the caption says so.
 *
 * CO-LOCATED STOPS ARE FANNED, NOT STACKED. Several calls in one clinic building share a GPS fix to
 * within a few metres, so their markers land on the same pixel and all but the last disappear. Each
 * group is spread on a short arc with a leader line back to the true fix — the reader sees every
 * stop AND where it really was.
 */

import type { FieldActivityStop } from "@/lib/field-activity/model";

const DEEP = "#0A527D";
const BLUE = "#0A6BA6";
const INK = "#000000";
const MUTED = "#5A6B7C";
const HAIR = "#B9C7D4";

export type RouteMapPoint = {
  lat: number;
  lon: number;
  label: string;
  kind: "stop" | "capture";
};

export function stopsToMapPoints(stops: FieldActivityStop[], capture?: { lat: number; lon: number; label: string } | null): RouteMapPoint[] {
  const points: RouteMapPoint[] = stops.map((stop) => ({
    lat: stop.lat,
    lon: stop.lon,
    label: String(stop.index),
    kind: "stop",
  }));
  if (capture) points.push({ lat: capture.lat, lon: capture.lon, label: capture.label, kind: "capture" });
  return points;
}

/** Web-mercator pixel at a zoom, in the 256-tile scheme Google and OSM share. */
function project(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

/** The largest zoom at which every point still sits inside the frame with room for its marker. */
export function fitZoom(points: RouteMapPoint[], width: number, height: number, padding = 78): number {
  if (points.length <= 1) return 14;
  for (let zoom = 18; zoom > 2; zoom -= 1) {
    const xs = points.map((p) => project(p.lon, p.lat, zoom).x);
    const ys = points.map((p) => project(p.lon, p.lat, zoom).y);
    if (Math.max(...xs) - Math.min(...xs) <= width - 2 * padding && Math.max(...ys) - Math.min(...ys) <= height - 2 * padding) {
      return zoom;
    }
  }
  return 3;
}

function centreOf(points: RouteMapPoint[]): { lat: number; lon: number } {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return { lat: (Math.max(...lats) + Math.min(...lats)) / 2, lon: (Math.max(...lons) + Math.min(...lons)) / 2 };
}

/**
 * The basemap as a data URI, or null when it could not be fetched.
 *
 * `scale=2` doubles the pixel density for print without changing the coordinate frame, so the
 * geometry below is unaffected — the image is simply sharper on paper.
 *
 * 🔴 A REFUSAL IS LOGGED, NOT ONLY SWALLOWED — THAT SILENCE IS WHY THE PDF LOST ITS STREETS FOR
 * WEEKS AND NOBODY COULD SAY WHY. Returning null on any failure is right: a map is worth having and
 * never worth failing an export for (see the module docstring). But null was the ONLY signal, so
 * "no key configured", "key refused", "API not enabled on the project" and "Google timed out" were
 * one indistinguishable outcome, and the sheet's own caption could say nothing more useful than
 * "unavailable". Measured 2026-10-06: the production server key answers Geocoding and Routes with
 * 200 and the Maps Static API with **403, "This API is not activated on your API project"** — a
 * one-click Cloud Console omission that cost every exported route map its streets and left no trace
 * anywhere to find it by.
 *
 * The key is stripped from anything logged: it is a URL parameter here, so a bare `url` or a
 * verbatim Google error would put a live credential in the log.
 */
export type BasemapRequest = {
  centre: { lat: number; lon: number };
  zoom: number;
  width: number;
  height: number;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  /** Who is asking, for the log line. The route map when left out. */
  caller?: string;
};

/**
 * The picture's own bytes, or null. `fetchBasemap` below wraps them for a sheet that embeds the picture;
 * the Location Integrity maps' route (13 Nov 2026) serves them as they are.
 */
export async function fetchBasemapPng(input: BasemapRequest): Promise<Buffer | null> {
  const caller = input.caller ?? "field-activity basemap";
  if (!input.apiKey) {
    console.warn(`${caller}: GOOGLE_MAPS_SERVER_KEY is not set — the map is drawn without streets`);
    return null;
  }
  const url =
    "https://maps.googleapis.com/maps/api/staticmap" +
    `?center=${input.centre.lat},${input.centre.lon}` +
    `&zoom=${input.zoom}&size=${input.width}x${input.height}&scale=2&maptype=roadmap&format=png` +
    // The route and the markers are drawn on top, so the basemap is deliberately quiet: points of
    // interest and transit clutter compete with numbered stops at this size.
    "&style=feature:poi|visibility:simplified&style=feature:transit|visibility:off" +
    `&key=${encodeURIComponent(input.apiKey)}`;
  const withoutKey = (text: string) => text.split(input.apiKey ?? "").join("<key>");
  try {
    const response = await (input.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) {
      // Google answers a refused static map in plain text and names the cause exactly — which API is
      // off, which restriction bit, whether billing lapsed. That sentence is the whole diagnosis, so
      // it is logged rather than discarded.
      const reason = await response.text().catch(() => "");
      console.warn(
        `${caller}: Google refused the Maps Static API with HTTP ${response.status} — ` +
          `${withoutKey(reason).replace(/\s+/g, " ").trim().slice(0, 300)}`,
      );
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // A map is worth having and never worth failing an export for — but a timeout that leaves no
    // trace is how this stayed unexplained, so the throw is recorded on its way to the same null.
    console.warn(`${caller}: the Maps Static API request failed — ${withoutKey(error instanceof Error ? error.message : String(error))}`);
    return null;
  }
}

/** The same picture as a data address, for a sheet that embeds it. Null on every failure, each one logged above. */
export async function fetchBasemap(input: BasemapRequest): Promise<string | null> {
  const png = await fetchBasemapPng(input);
  return png ? `data:image/png;base64,${png.toString("base64")}` : null;
}

/** Groups of markers whose pixels collide, fanned onto a short arc with leader lines. */
function placeMarkers(anchors: Array<{ x: number; y: number }>): Array<{ x: number; y: number; fanned: boolean }> {
  const placed = anchors.map((anchor) => ({ ...anchor, fanned: false }));
  const taken = new Array(anchors.length).fill(false);
  for (let i = 0; i < anchors.length; i += 1) {
    if (taken[i]) continue;
    const group: number[] = [];
    for (let j = 0; j < anchors.length; j += 1) {
      if (taken[j]) continue;
      if (Math.hypot(anchors[i].x - anchors[j].x, anchors[i].y - anchors[j].y) < 30) group.push(j);
    }
    for (const index of group) taken[index] = true;
    if (group.length === 1) continue;
    const radius = 34 + 7 * group.length;
    group.forEach((index, position) => {
      const angle = -Math.PI / 2 + (position - (group.length - 1) / 2) * (Math.PI / 3.1);
      placed[index] = {
        x: anchors[index].x + radius * Math.cos(angle),
        y: anchors[index].y + radius * Math.sin(angle),
        fanned: true,
      };
    });
  }
  return placed;
}

export function renderRouteSvg(input: {
  points: RouteMapPoint[];
  width: number;
  height: number;
  basemap: string | null;
  zoom: number;
}): string {
  const { points, width, height, zoom } = input;
  if (points.length === 0) return "";
  const centre = centreOf(points);
  const centrePx = project(centre.lon, centre.lat, zoom);
  const originX = centrePx.x - width / 2;
  const originY = centrePx.y - height / 2;
  const anchors = points.map((point) => {
    const pixel = project(point.lon, point.lat, zoom);
    return { x: pixel.x - originX, y: pixel.y - originY };
  });
  const placed = placeMarkers(anchors);

  const parts: string[] = [];
  parts.push(
    input.basemap
      ? `<image href="${input.basemap}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none"/>`
      : `<rect x="0" y="0" width="${width}" height="${height}" fill="#F7F9FB"/>`,
  );
  // A wash keeps the basemap behind the type rather than beside it.
  if (input.basemap) parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#FFFFFF" opacity="0.26"/>`);

  const stopIndexes = points.map((point, index) => ({ point, index })).filter((entry) => entry.point.kind === "stop");
  if (stopIndexes.length > 1) {
    const path = stopIndexes.map((entry) => `${anchors[entry.index].x.toFixed(1)},${anchors[entry.index].y.toFixed(1)}`).join(" ");
    parts.push(`<polyline points="${path}" fill="none" stroke="#FFFFFF" stroke-width="9" stroke-linejoin="round"/>`);
    parts.push(`<polyline points="${path}" fill="none" stroke="${BLUE}" stroke-width="5" stroke-linejoin="round"/>`);
  }

  points.forEach((point, index) => {
    const anchor = anchors[index];
    const spot = placed[index];
    if (spot.fanned) {
      parts.push(`<line x1="${anchor.x.toFixed(1)}" y1="${anchor.y.toFixed(1)}" x2="${spot.x.toFixed(1)}" y2="${spot.y.toFixed(1)}" stroke="${DEEP}" stroke-width="2" opacity="0.75"/>`);
      parts.push(`<circle cx="${anchor.x.toFixed(1)}" cy="${anchor.y.toFixed(1)}" r="3" fill="${DEEP}"/>`);
    }
    if (point.kind === "capture") {
      const r = 15;
      parts.push(`<rect x="${spot.x - r}" y="${spot.y - r}" width="${2 * r}" height="${2 * r}" fill="none" stroke="${INK}" stroke-width="3"/>`);
      parts.push(`<line x1="${spot.x - r + 5}" y1="${spot.y}" x2="${spot.x + r - 5}" y2="${spot.y}" stroke="${INK}" stroke-width="2"/>`);
      parts.push(`<line x1="${spot.x}" y1="${spot.y - r + 5}" x2="${spot.x}" y2="${spot.y + r - 5}" stroke="${INK}" stroke-width="2"/>`);
      const labelWidth = point.label.length * 9 + 14;
      parts.push(`<rect x="${spot.x + r + 8}" y="${spot.y - 14}" width="${labelWidth}" height="28" fill="#FFFFFF" fill-opacity="0.92" stroke="${INK}"/>`);
      parts.push(`<text x="${spot.x + r + 15}" y="${spot.y + 5}" font-family="Segoe UI, Arial, sans-serif" font-size="16" font-weight="700" fill="${INK}">${escapeXml(point.label)}</text>`);
      return;
    }
    const r = 18;
    parts.push(`<rect x="${spot.x - r}" y="${spot.y - r}" width="${2 * r}" height="${2 * r}" fill="#FFFFFF" stroke="${DEEP}" stroke-width="3"/>`);
    parts.push(`<rect x="${spot.x - r + 4}" y="${spot.y - r + 4}" width="${2 * (r - 4)}" height="${2 * (r - 4)}" fill="${DEEP}"/>`);
    parts.push(`<text x="${spot.x}" y="${spot.y + 7}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="19" font-weight="700" fill="#FFFFFF">${escapeXml(point.label)}</text>`);
  });

  // Scale bar — measured at this zoom and latitude, never assumed.
  const metresPerPixel = (156543.03392 * Math.cos((centre.lat * Math.PI) / 180)) / 2 ** zoom;
  let metres = 100;
  for (const candidate of [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]) {
    metres = candidate;
    if (candidate / metresPerPixel >= 110) break;
  }
  const bar = metres / metresPerPixel;
  const barY = height - 34;
  parts.push(`<rect x="18" y="${barY - 26}" width="${bar + 24}" height="42" fill="#FFFFFF" fill-opacity="0.88" stroke="${HAIR}"/>`);
  parts.push(`<line x1="26" y1="${barY}" x2="${26 + bar}" y2="${barY}" stroke="${INK}" stroke-width="3"/>`);
  parts.push(`<line x1="26" y1="${barY - 7}" x2="26" y2="${barY + 7}" stroke="${INK}" stroke-width="3"/>`);
  parts.push(`<line x1="${26 + bar}" y1="${barY - 7}" x2="${26 + bar}" y2="${barY + 7}" stroke="${INK}" stroke-width="3"/>`);
  parts.push(`<text x="26" y="${barY - 10}" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="${INK}">${metres < 1000 ? `${metres} m` : `${metres / 1000} km`}</text>`);

  if (!input.basemap) {
    parts.push(`<text x="${width - 12}" y="${height - 12}" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="14" fill="${MUTED}">Street basemap unavailable — positions and route are exact</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img">${parts.join("")}</svg>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
