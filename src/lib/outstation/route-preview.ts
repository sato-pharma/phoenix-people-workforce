import type {
  OutstationCalculationResult,
  OutstationExpenseRequest,
  OutstationRouteAlternative,
} from "@/lib/outstation/types";

type RoutePreviewRequest = OutstationCalculationResult | OutstationExpenseRequest | null;

export type RoutePreviewPoint = { lat: number; lng: number };

export type RoutePreviewModel = {
  destination: { x: number; y: number };
  height: number;
  path: string;
  pathPoints: Array<{ x: number; y: number }>;
  residence: { x: number; y: number };
  tiles: Array<{ left: number; top: number; url: string }>;
  width: number;
};

const defaultMapSize = { height: 420, width: 900 };
const minMapSize = { height: 240, width: 320 };

export function decodePolyline(encoded: string): RoutePreviewPoint[] {
  const points: RoutePreviewPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const latChange = result & 1 ? ~(result >> 1) : result >> 1;
    lat += latChange;

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const lngChange = result & 1 ? ~(result >> 1) : result >> 1;
    lng += lngChange;

    points.push({
      lat: lat / 1e5,
      lng: lng / 1e5,
    });
  }

  return points;
}

export function safeDecodePolyline(encoded?: string | null) {
  if (!encoded) return [];
  try {
    return decodePolyline(encoded);
  } catch {
    return [];
  }
}

export function outstationRouteCoordinatesReady(request: RoutePreviewRequest) {
  return Boolean(
    request &&
      request.residenceLatitude != null &&
      request.residenceLongitude != null &&
      Number.isFinite(request.capturedLatitude) &&
      Number.isFinite(request.capturedLongitude),
  );
}

export function selectedRouteForSummary(request: RoutePreviewRequest) {
  return request?.routeAlternatives?.find((route) => route.isSelected) ?? null;
}

export function routesForMap(request: RoutePreviewRequest): OutstationRouteAlternative[] {
  if (!request) return [];

  const alternatives = request.routeAlternatives?.filter((route) => route.encodedPolyline) ?? [];
  if (alternatives.length > 0) return alternatives;

  return request.routePolyline
    ? [
        {
          distanceKm: request.distanceFromResidenceKm,
          durationInTrafficMinutes: null,
          durationMinutes: request.durationMinutes,
          encodedPolyline: request.routePolyline,
          index: 0,
          isSelected: true,
          summary: null,
        },
      ]
    : [];
}

export function selectedRouteForMap(request: RoutePreviewRequest) {
  if (!request) return null;

  const routes = routesForMap(request);
  return routes.find((route) => route.isSelected) ?? routes[0] ?? null;
}

export function buildRoutePreviewKey(request: RoutePreviewRequest) {
  if (
    !request ||
    request.residenceLatitude == null ||
    request.residenceLongitude == null ||
    !Number.isFinite(request.capturedLatitude) ||
    !Number.isFinite(request.capturedLongitude)
  ) {
    return null;
  }

  const selectedRoute = selectedRouteForMap(request);

  return [
    request.residenceLatitude,
    request.residenceLongitude,
    request.capturedLatitude,
    request.capturedLongitude,
    selectedRoute?.index ?? "direct",
    selectedRoute?.encodedPolyline ?? request.routePolyline ?? "no-route",
    request.eligibilityStatus,
    request.approvalRecommendation,
  ].join("|");
}

export function routePreviewPoints(
  request: RoutePreviewRequest,
  route: OutstationRouteAlternative | null,
) {
  if (!request) return [];

  if (route?.encodedPolyline) {
    try {
      const decoded = decodePolyline(route.encodedPolyline);
      if (decoded.length > 1) return decoded;
    } catch {
      // Fall back to the direct residence-to-destination line below.
    }
  }

  return [
    { lat: request.residenceLatitude!, lng: request.residenceLongitude! },
    { lat: request.capturedLatitude, lng: request.capturedLongitude },
  ];
}

function normalizedMapSize(size?: { height: number; width: number }) {
  const width = Number.isFinite(size?.width)
    ? Math.max(minMapSize.width, Math.round(size!.width))
    : defaultMapSize.width;
  const height = Number.isFinite(size?.height)
    ? Math.max(minMapSize.height, Math.round(size!.height))
    : defaultMapSize.height;

  return { height, width };
}

function latLngToWorld(point: RoutePreviewPoint, zoom: number) {
  const sinLat = Math.max(-0.9999, Math.min(0.9999, Math.sin((point.lat * Math.PI) / 180)));
  const scale = 256 * 2 ** zoom;

  return {
    x: ((point.lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}

export function buildTileRouteMapModel(
  request: OutstationExpenseRequest | OutstationCalculationResult,
  route: OutstationRouteAlternative | null,
  size?: { height: number; width: number },
): RoutePreviewModel {
  const { height, width } = normalizedMapSize(size);
  const points = routePreviewPoints(request, route);
  const routePathPoints = route?.encodedPolyline ? safeDecodePolyline(route.encodedPolyline) : [];
  const decodedBoundsPoints =
    routePathPoints.length >= 2 ? routePathPoints : [];
  const boundsPoints = [
    ...points,
    ...decodedBoundsPoints,
    { lat: request.residenceLatitude!, lng: request.residenceLongitude! },
    { lat: request.capturedLatitude, lng: request.capturedLongitude },
  ];
  const horizontalPadding = Math.min(140, Math.max(48, width * 0.13));
  const verticalPadding = Math.min(120, Math.max(48, height * 0.17));
  let zoom = 5;

  for (let candidate = 12; candidate >= 3; candidate -= 1) {
    const worldPoints = boundsPoints.map((point) => latLngToWorld(point, candidate));
    const minX = Math.min(...worldPoints.map((point) => point.x));
    const maxX = Math.max(...worldPoints.map((point) => point.x));
    const minY = Math.min(...worldPoints.map((point) => point.y));
    const maxY = Math.max(...worldPoints.map((point) => point.y));

    if (
      maxX - minX <= width - horizontalPadding * 2 &&
      maxY - minY <= height - verticalPadding * 2
    ) {
      zoom = candidate;
      break;
    }
  }

  const worldPoints = boundsPoints.map((point) => latLngToWorld(point, zoom));
  const minX = Math.min(...worldPoints.map((point) => point.x));
  const maxX = Math.max(...worldPoints.map((point) => point.x));
  const minY = Math.min(...worldPoints.map((point) => point.y));
  const maxY = Math.max(...worldPoints.map((point) => point.y));
  const center = {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
  const origin = {
    x: center.x - width / 2,
    y: center.y - height / 2,
  };
  const project = (point: RoutePreviewPoint) => {
    const world = latLngToWorld(point, zoom);
    return {
      x: world.x - origin.x,
      y: world.y - origin.y,
    };
  };
  const minTileX = Math.floor(origin.x / 256);
  const maxTileX = Math.floor((origin.x + width) / 256);
  const minTileY = Math.floor(origin.y / 256);
  const maxTileY = Math.floor((origin.y + height) / 256);
  const tileLimit = 2 ** zoom;
  const tiles: RoutePreviewModel["tiles"] = [];

  for (let x = minTileX; x <= maxTileX; x += 1) {
    for (let y = minTileY; y <= maxTileY; y += 1) {
      if (y < 0 || y >= tileLimit) continue;
      const wrappedX = ((x % tileLimit) + tileLimit) % tileLimit;
      tiles.push({
        left: x * 256 - origin.x,
        top: y * 256 - origin.y,
        url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`,
      });
    }
  }

  const pathPoints = points.map(project);

  return {
    destination: project({
      lat: request.capturedLatitude,
      lng: request.capturedLongitude,
    }),
    height,
    path: pathPoints
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" "),
    pathPoints,
    residence: project({
      lat: request.residenceLatitude!,
      lng: request.residenceLongitude!,
    }),
    tiles,
    width,
  };
}
