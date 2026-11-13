/**
 * The route picture on the printed trip review: home and destination, with the DRIVING route
 * between them drawn by Google from the polyline Phoenix already stored.
 *
 * ── The rule this exists to keep on paper ────────────────────────────────────
 *
 * The review screen drew a pin in the Gulf of Guinea on 2026-09-28, beside a confident
 * "FASTEST DISTANCE 209.62 KM": the request's residence coordinate was (0, 0), and the map's only
 * guard was `!= null`, which (0, 0) passes. The screen is fixed (`outstation-review-map.tsx`); this
 * is the same guard for the printed copy, so the PDF can never reproduce the picture it was built
 * to replace. An unresolved home — null island or the Egypt centroid — is simply not plotted, and
 * the caption says so in words.
 *
 * `buildRouteStaticMapUrl` is pure so the guard is testable without a key or a network. The fetch
 * turns the answer into a data URI, so the API key lives only in the one server-side request and
 * never inside the document.
 */

import { isUnresolvedResidenceCoordinate } from "@/lib/outstation/distance-failure";

/** Google's documented ceiling for a Static Maps request URL. */
const STATIC_MAPS_URL_LIMIT = 16_384;

// The Phoenix palette, not the Sato one: this picture goes on the review screen's own PDF, which is
// the screen on paper (owner, 2026-09-29: "do not brand Sato, extract the exact view"). Slate for
// home, accent orange for the destination and the road between them.
const HOME_COLOUR = "0x0f172a";
const DESTINATION_COLOUR = "0xf97316";
const ROUTE_COLOUR = "0xf97316DD";

type Point = { lat: number; lng: number };

export type RouteStaticMapPlan = {
  /** What the caption under the picture says. Always set — a missing picture still explains itself. */
  caption: string;
  /** The captured destination, or null when there is no usable one. */
  destination: Point | null;
  /**
   * The employee's home, or null when it is unresolved. 🔴 THE GUARD LIVES HERE, and every renderer
   * reads it rather than re-deciding: null island and the Egypt centroid are never plotted.
   */
  home: Point | null;
  /** The request to make, or null when there is nothing honest to draw. */
  url: string | null;
};

function usable(point: { lat: number | null | undefined; lng: number | null | undefined }): point is Point {
  return (
    typeof point.lat === "number" && Number.isFinite(point.lat)
    && typeof point.lng === "number" && Number.isFinite(point.lng)
  );
}

export function buildRouteStaticMapUrl(input: {
  apiKey: string | null;
  destination: { lat: number | null | undefined; lng: number | null | undefined };
  polyline: string | null | undefined;
  residence: { lat: number | null | undefined; lng: number | null | undefined };
}): RouteStaticMapPlan {
  const destination = usable(input.destination) ? input.destination : null;
  const homeResolved =
    usable(input.residence) && !isUnresolvedResidenceCoordinate(input.residence.lat, input.residence.lng);
  const home = homeResolved ? (input.residence as Point) : null;

  if (!input.apiKey) {
    return { caption: "The map could not be drawn: Google Maps is not configured on this server.", destination, home, url: null };
  }

  if (!destination && !home) {
    return { caption: "No usable coordinate is on file for either end of this trip, so there is no map.", destination, home, url: null };
  }

  const params = [
    "size=640x340",
    "scale=2",
    "maptype=roadmap",
    "format=png",
    // The route is the subject; points of interest and transit only compete with it at this size.
    "style=feature:poi|visibility:simplified",
    "style=feature:transit|visibility:off",
  ];
  if (home) params.push(`markers=${encodeURIComponent(`color:${HOME_COLOUR}|label:H|${home.lat},${home.lng}`)}`);
  if (destination) {
    params.push(`markers=${encodeURIComponent(`color:${DESTINATION_COLOUR}|label:D|${destination.lat},${destination.lng}`)}`);
  }

  // The stored polyline is the route measured FROM HOME. With no resolved home it would trace a
  // road that starts somewhere the traveller never lived, so it is only drawn beside a real home.
  const polyline = String(input.polyline ?? "").trim();
  let drewRoute = false;
  if (home && polyline) {
    const withPath = [...params, `path=${encodeURIComponent(`weight:4|color:${ROUTE_COLOUR}|enc:${polyline}`)}`];
    const candidate = `https://maps.googleapis.com/maps/api/staticmap?${withPath.join("&")}&key=${encodeURIComponent(input.apiKey)}`;
    if (candidate.length <= STATIC_MAPS_URL_LIMIT) {
      params.push(withPath[withPath.length - 1]);
      drewRoute = true;
    }
  }

  const url = `https://maps.googleapis.com/maps/api/staticmap?${params.join("&")}&key=${encodeURIComponent(input.apiKey)}`;

  const caption = !home
    ? "Destination only (D). No resolved home coordinate is on file, so neither home nor the route is drawn — a placeholder is never plotted as a place."
    : !destination
      ? "Home only (H). No captured destination is on file for this request."
      : drewRoute
        ? "H is the employee's registered home, D the captured destination, and the line the driving route the distance was measured along."
        : "H is the employee's registered home and D the captured destination. The driving route is too long to draw at this size; the distance above is the measured one.";

  return { caption, destination, home, url };
}

/** Fetches the planned map as a data URI, or null. A map that fails to load never fails the PDF. */
export async function fetchRouteStaticMap(
  plan: RouteStaticMapPlan,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!plan.url) return null;
  try {
    // Ten seconds, then the PDF prints without its map, as it does for any other map failure
    // (integration audit, 13 Nov 2026, ISS-011); the call had no deadline and the route's whole budget is 90 seconds.
    const response = await fetchImpl(plan.url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      console.warn(`[outstation-review-pdf] static map ${response.status}`);
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") || "image/png";
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch (error) {
    console.warn("[outstation-review-pdf] static map failed", error);
    return null;
  }
}

// ── The route drawn by Phoenix itself, for when Google will not draw it ─────────────────────────
//
// Measured 2026-09-29: the Maps Static API answers 403 "This API is not activated on your API
// project" for the key in `.env.local`, while Geocoding answers 200 with the same key. So the street
// map above is not something the printed review can rely on. The route itself IS on file — the
// encoded polyline Google returned when the distance was measured — so the document draws that
// line between home and destination on a plain ground. It needs no key and no network, and it is
// the same guard: an unresolved home is never plotted, and without a home there is no route.

/** Decodes a Google encoded polyline. A malformed tail ends the line; it never throws. */
export function decodePolyline(encoded: string | null | undefined): Point[] {
  const text = String(encoded ?? "");
  const points: Point[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number | null => {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      if (index >= text.length) return null;
      byte = text.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < text.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) break;
    lat += dLat;
    lng += dLng;
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** Web Mercator, normalised to 0..1 on both axes. */
function mercator(point: Point): { x: number; y: number } {
  const clamped = Math.max(-85, Math.min(85, point.lat));
  const rad = (clamped * Math.PI) / 180;
  return {
    x: (point.lng + 180) / 360,
    y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2,
  };
}

function marker(x: number, y: number, letter: string, fill: string, ring: string, ink: string): string {
  return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="17" fill="${fill}" stroke="${ring}" stroke-width="3"/>`
    + `<text x="${x.toFixed(1)}" y="${(y + 7).toFixed(1)}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="700" fill="${ink}">${letter}</text></g>`;
}

/**
 * The route as an SVG data URI: H (home), D (destination), and the stored driving line between
 * them. Null when there is nothing honest to draw. Pure.
 */
export function renderRouteDiagram(input: {
  destination: { lat: number | null | undefined; lng: number | null | undefined };
  polyline: string | null | undefined;
  residence: { lat: number | null | undefined; lng: number | null | undefined };
}): { caption: string; image: string } | null {
  const width = 1280;
  const height = 680;
  const pad = 70;

  const destination = usable(input.destination) ? input.destination : null;
  const home =
    usable(input.residence) && !isUnresolvedResidenceCoordinate(input.residence.lat, input.residence.lng)
      ? (input.residence as Point)
      : null;
  // The stored line is the route measured FROM HOME; with no resolved home it is not drawn at all.
  const line = home ? decodePolyline(input.polyline) : [];

  const all = [...line, ...(home ? [home] : []), ...(destination ? [destination] : [])];
  if (all.length === 0) return null;

  const projected = all.map(mercator);
  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // A single point (or two on top of each other) still needs a finite frame.
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const toXY = (point: Point) => {
    const m = mercator(point);
    return { x: offsetX + (m.x - minX) * scale, y: offsetY + (m.y - minY) * scale };
  };

  const parts: string[] = [
    // THE INK RULE: no filled ground. A hairline frame, and white.
    `<rect x="1.5" y="1.5" width="${width - 3}" height="${height - 3}" fill="#FFFFFF" stroke="#e0dcd4" stroke-width="3"/>`,
  ];
  if (line.length > 1) {
    const d = line.map((p, i) => {
      const { x, y } = toXY(p);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    parts.push(`<path d="${d}" fill="none" stroke="#f97316" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  if (home) {
    const { x, y } = toXY(home);
    parts.push(marker(x, y, "H", "#0f172a", "#FFFFFF", "#FFFFFF"));
  }
  if (destination) {
    const { x, y } = toXY(destination);
    parts.push(marker(x, y, "D", "#FFFFFF", "#f97316", "#0f172a"));
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
  const caption = !home
    ? "Destination only (D), drawn by Phoenix. No resolved home coordinate is on file, so neither home nor the route is drawn — a placeholder is never plotted as a place."
    : !destination
      ? "Home only (H), drawn by Phoenix. No captured destination is on file for this request."
      : line.length > 1
        ? "H is the employee’s registered home, D the captured destination, and the line the driving route the distance was measured along — drawn by Phoenix from the stored route, as no street map was available."
        : "H is the employee’s registered home and D the captured destination, drawn by Phoenix. No stored route line is on file for this request.";
  return { caption, image: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}` };
}
