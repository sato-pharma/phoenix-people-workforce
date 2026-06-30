type LatLng = { lat: number; lng: number };

export type GoogleRoutesApiRoute = {
  description?: string;
  distanceMeters?: number;
  duration?: string;
  routeLabels?: string[];
  staticDuration?: string;
  polyline?: { encodedPolyline?: string };
};

export type GoogleRouteAlternative = {
  distanceMeters: number | null;
  durationInTrafficSeconds: number | null;
  durationSeconds: number | null;
  encodedPolyline: string | null;
  index: number;
  isSelected: boolean;
  summary: string | null;
};

type GeocodeResponse = {
  area: string | null;
  city: string | null;
  formattedAddress: string | null;
  lat: number;
  lng: number;
};

async function postJsonWithHttpsFallback(
  url: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: "POST";
  },
) {
  try {
    return await fetch(url, {
      body: init.body,
      cache: "no-store",
      headers: init.headers,
      method: init.method,
    });
  } catch {
    const { request } = await import("node:https");
    const parsed = new URL(url);

    return await new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          headers: init.headers,
          hostname: parsed.hostname,
          method: init.method,
          path: `${parsed.pathname}${parsed.search}`,
          port: parsed.port ? Number(parsed.port) : 443,
          protocol: parsed.protocol,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve(
              new Response(body, {
                headers: Object.fromEntries(
                  Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""]),
                ),
                status: res.statusCode ?? 500,
                statusText: res.statusMessage ?? "",
              }),
            );
          });
        },
      );

      req.on("error", reject);
      req.write(init.body);
      req.end();
    });
  }
}

function getServerKey() {
  return process.env.GOOGLE_MAPS_SERVER_KEY ?? "";
}

function parseDurationSeconds(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw.endsWith("s")) return null;
  const seconds = Number(raw.slice(0, -1));
  return Number.isFinite(seconds) ? seconds : null;
}

function routeDistanceMeters(route: GoogleRoutesApiRoute) {
  return route.distanceMeters != null && Number.isFinite(route.distanceMeters)
    ? Number(route.distanceMeters)
    : null;
}

function routeDurationSeconds(route: GoogleRoutesApiRoute) {
  return parseDurationSeconds(route.staticDuration ?? route.duration);
}

function routeDurationInTrafficSeconds(route: GoogleRoutesApiRoute) {
  return route.staticDuration ? parseDurationSeconds(route.duration) : null;
}

function routeComparableDurationSeconds(route: GoogleRoutesApiRoute) {
  return routeDurationInTrafficSeconds(route) ?? routeDurationSeconds(route);
}

function routeSummary(route: GoogleRoutesApiRoute) {
  const labels = Array.isArray(route.routeLabels) ? route.routeLabels.filter(Boolean) : [];
  return route.description ?? (labels.length > 0 ? labels.join(", ") : null);
}

export function selectFastestGoogleRoute(
  routes: GoogleRoutesApiRoute[] | null | undefined,
) {
  return routes?.reduce<GoogleRoutesApiRoute | null>((fastest, route) => {
    const durationSeconds = routeComparableDurationSeconds(route);
    if (durationSeconds == null) return fastest;

    const fastestDurationSeconds = fastest ? routeComparableDurationSeconds(fastest) : null;
    if (fastestDurationSeconds == null || durationSeconds < fastestDurationSeconds) {
      return route;
    }

    return fastest;
  }, null) ?? null;
}

export function buildGoogleRouteAlternatives(
  routes: GoogleRoutesApiRoute[] | null | undefined,
) {
  const entries = routes ?? [];
  const selected = selectFastestGoogleRoute(entries);
  const selectedRouteIndex = selected ? entries.indexOf(selected) : -1;

  return entries.map<GoogleRouteAlternative>((item, index) => ({
    distanceMeters: routeDistanceMeters(item),
    durationInTrafficSeconds: routeDurationInTrafficSeconds(item),
    durationSeconds: routeDurationSeconds(item),
    encodedPolyline: item.polyline?.encodedPolyline ?? null,
    index,
    isSelected: index === selectedRouteIndex,
    summary: routeSummary(item),
  }));
}

async function computeRoutes(
  origin: LatLng,
  destination: LatLng,
): Promise<{
  alternatives: GoogleRouteAlternative[];
  distanceMeters: number | null;
  durationInTrafficSeconds: number | null;
  durationSeconds: number | null;
  polyline: string | null;
  selectedRouteIndex: number | null;
}> {
  const key = getServerKey();
  if (!key) {
    return {
      alternatives: [],
      distanceMeters: null,
      durationInTrafficSeconds: null,
      durationSeconds: null,
      polyline: null,
      selectedRouteIndex: null,
    };
  }

  async function requestRoutes(options: {
    computeAlternativeRoutes: boolean;
    routingPreference: "TRAFFIC_AWARE" | "TRAFFIC_UNAWARE";
  }) {
    const response = await postJsonWithHttpsFallback(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        body: JSON.stringify({
          computeAlternativeRoutes: options.computeAlternativeRoutes,
          destination: {
            location: {
              latLng: {
                latitude: destination.lat,
                longitude: destination.lng,
              },
            },
          },
          origin: {
            location: {
              latLng: {
                latitude: origin.lat,
                longitude: origin.lng,
              },
            },
          },
          polylineEncoding: "ENCODED_POLYLINE",
          polylineQuality: "OVERVIEW",
          routingPreference: options.routingPreference,
          travelMode: "DRIVE",
        }),
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask":
            "routes.description,routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.routeLabels,routes.staticDuration",
        },
        method: "POST",
      },
    );

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(
        `Google Routes API failed with ${response.status}${details ? `: ${details.slice(0, 240)}` : ""}.`,
      );
    }

    return response;
  }

  let response: Response;
  try {
    response = await requestRoutes({
      computeAlternativeRoutes: true,
      routingPreference: "TRAFFIC_AWARE",
    });
  } catch (trafficAwareAlternativesError) {
    try {
      response = await requestRoutes({
        computeAlternativeRoutes: true,
        routingPreference: "TRAFFIC_UNAWARE",
      });
    } catch {
      try {
        response = await requestRoutes({
          computeAlternativeRoutes: false,
          routingPreference: "TRAFFIC_AWARE",
        });
      } catch {
        try {
          response = await requestRoutes({
            computeAlternativeRoutes: false,
            routingPreference: "TRAFFIC_UNAWARE",
          });
        } catch {
          throw trafficAwareAlternativesError;
        }
      }
    }
  }

  const payload = (await response.json()) as {
    routes?: GoogleRoutesApiRoute[];
  };

  const routes = payload.routes ?? [];
  const route = selectFastestGoogleRoute(routes);
  const selectedRouteIndex = route ? routes.indexOf(route) : -1;
  const alternatives = buildGoogleRouteAlternatives(routes);

  return {
    alternatives,
    distanceMeters: route ? routeDistanceMeters(route) : null,
    durationInTrafficSeconds: route ? routeDurationInTrafficSeconds(route) : null,
    durationSeconds: route ? routeDurationSeconds(route) : null,
    polyline: route?.polyline?.encodedPolyline ?? null,
    selectedRouteIndex: selectedRouteIndex >= 0 ? selectedRouteIndex : null,
  };
}

export function getBrowserKey() {
  return process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
}

export function hasGoogleServerKey() {
  return getServerKey().trim().length > 0;
}

export async function googleGeocodeAddress(address: string): Promise<LatLng | null> {
  const key = getServerKey();
  if (!key || !address.trim()) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", key);

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Google Geocoding API failed with ${response.status}.`);
  }

  const payload = (await response.json()) as {
    results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    status?: string;
  };

  const location = payload.results?.[0]?.geometry?.location;
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return null;
  }

  return { lat: Number(location.lat), lng: Number(location.lng) };
}

export async function googleGeocodeGovernorate(searchText: string): Promise<string | null> {
  const key = getServerKey();
  if (!key || !searchText.trim()) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", `${searchText}, Egypt`);
  url.searchParams.set("key", key);
  url.searchParams.set("language", "en");

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) return null;

  const payload = (await response.json()) as {
    results?: Array<{
      address_components?: Array<{ long_name?: string; types?: string[] }>;
    }>;
  };

  const components = payload.results?.[0]?.address_components ?? [];
  const gov = components.find(
    (c) => Array.isArray(c.types) && c.types.includes("administrative_area_level_1"),
  );
  return gov?.long_name?.replace(/\s*Governorate$/i, "").trim() ?? null;
}

function extractAddressComponent(
  components: Array<{ long_name?: string; short_name?: string; types?: string[] }> | undefined,
  targetTypes: string[],
) {
  const component = components?.find((entry) =>
    Array.isArray(entry.types) && entry.types.some((type) => targetTypes.includes(type)),
  );
  return component?.long_name ?? component?.short_name ?? null;
}

export async function googleReverseGeocode(
  location: LatLng,
): Promise<GeocodeResponse | null> {
  const key = getServerKey();
  if (!key) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", `${location.lat},${location.lng}`);
  url.searchParams.set("key", key);

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Google Reverse Geocoding API failed with ${response.status}.`);
  }

  const payload = (await response.json()) as {
    results?: Array<{
      address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>;
      formatted_address?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
    }>;
  };

  const result = payload.results?.[0];
  const geo = result?.geometry?.location;
  if (!result || !geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) {
    return null;
  }

  return {
    area:
      extractAddressComponent(result.address_components, [
        "sublocality",
        "sublocality_level_1",
        "administrative_area_level_2",
      ]) ?? null,
    city:
      extractAddressComponent(result.address_components, [
        "locality",
        "administrative_area_level_1",
      ]) ?? null,
    formattedAddress: result.formatted_address ?? null,
    lat: Number(geo.lat),
    lng: Number(geo.lng),
  };
}

export async function googleDistanceMatrix(
  origin: LatLng,
  destination: LatLng,
): Promise<{ distanceMeters: number | null; durationInTrafficSeconds: number | null; durationSeconds: number | null }> {
  const element = await computeRoutes(origin, destination);
  return {
    distanceMeters: element.distanceMeters,
    durationInTrafficSeconds: element.durationInTrafficSeconds,
    durationSeconds: element.durationSeconds,
  };
}

export async function googleDirectionsRoute(
  origin: LatLng,
  destination: LatLng,
): Promise<{
  alternatives: GoogleRouteAlternative[];
  distanceMeters: number | null;
  durationInTrafficSeconds: number | null;
  durationSeconds: number | null;
  polyline: string | null;
  selectedRouteIndex: number | null;
}> {
  return computeRoutes(origin, destination);
}

export type GoogleStopLeg = {
  distanceMeters: number | null;
  durationSeconds: number | null;
};

/**
 * Real driving route through an ordered list of stops (>= 2). Returns the overall
 * encoded polyline (follows roads) plus one leg per consecutive pair, each with the
 * driving distance and duration. Uses TRAFFIC_UNAWARE so it stays on the cheapest
 * "Compute Routes Essentials" SKU (10k free calls/month). Best-effort: returns null if
 * the server key is missing or the Routes API rejects the request, so callers can fall
 * back gracefully (and callers should cache successes to avoid repeat billing).
 */
export async function googleRouteThroughStops(stops: LatLng[]): Promise<{
  encodedPolyline: string | null;
  legs: GoogleStopLeg[];
} | null> {
  const key = getServerKey();
  if (!key || stops.length < 2) return null;

  const toWaypoint = (point: LatLng) => ({
    location: { latLng: { latitude: point.lat, longitude: point.lng } },
  });

  try {
    const response = await postJsonWithHttpsFallback(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        body: JSON.stringify({
          destination: toWaypoint(stops[stops.length - 1]),
          intermediates: stops.slice(1, -1).map(toWaypoint),
          origin: toWaypoint(stops[0]),
          polylineEncoding: "ENCODED_POLYLINE",
          polylineQuality: "OVERVIEW",
          routingPreference: "TRAFFIC_UNAWARE",
          travelMode: "DRIVE",
        }),
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration",
        },
        method: "POST",
      },
    );
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      routes?: Array<{
        legs?: Array<{ distanceMeters?: number; duration?: string }>;
        polyline?: { encodedPolyline?: string };
      }>;
    };
    const route = payload.routes?.[0];
    if (!route) return null;

    return {
      encodedPolyline: route.polyline?.encodedPolyline ?? null,
      legs: (route.legs ?? []).map((leg) => ({
        distanceMeters: leg.distanceMeters != null && Number.isFinite(leg.distanceMeters) ? Number(leg.distanceMeters) : null,
        durationSeconds: parseDurationSeconds(leg.duration),
      })),
    };
  } catch {
    return null;
  }
}
