type LatLng = { lat: number; lng: number };

export type GoogleRoutesApiRoute = {
  distanceMeters?: number;
  duration?: string;
  polyline?: { encodedPolyline?: string };
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

export function selectShortestGoogleRoute(
  routes: GoogleRoutesApiRoute[] | null | undefined,
) {
  return routes?.reduce<GoogleRoutesApiRoute | null>((shortest, route) => {
    const distanceMeters = routeDistanceMeters(route);
    if (distanceMeters == null) return shortest;

    const shortestDistanceMeters = shortest ? routeDistanceMeters(shortest) : null;
    if (shortestDistanceMeters == null || distanceMeters < shortestDistanceMeters) {
      return route;
    }

    return shortest;
  }, null) ?? null;
}

async function computeRoutes(
  origin: LatLng,
  destination: LatLng,
): Promise<{
  distanceMeters: number | null;
  durationSeconds: number | null;
  polyline: string | null;
}> {
  const key = getServerKey();
  if (!key) {
    return { distanceMeters: null, durationSeconds: null, polyline: null };
  }

  const response = await postJsonWithHttpsFallback(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      body: JSON.stringify({
        computeAlternativeRoutes: true,
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
        routingPreference: "TRAFFIC_UNAWARE",
        travelMode: "DRIVE",
      }),
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Google Routes API failed with ${response.status}.`);
  }

  const payload = (await response.json()) as {
    routes?: GoogleRoutesApiRoute[];
  };

  const route = selectShortestGoogleRoute(payload.routes);
  return {
    distanceMeters: route ? routeDistanceMeters(route) : null,
    durationSeconds: parseDurationSeconds(route?.duration),
    polyline: route?.polyline?.encodedPolyline ?? null,
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
): Promise<{ distanceMeters: number | null; durationSeconds: number | null }> {
  const element = await computeRoutes(origin, destination);
  return {
    distanceMeters: element.distanceMeters,
    durationSeconds: element.durationSeconds,
  };
}

export async function googleDirectionsRoute(
  origin: LatLng,
  destination: LatLng,
): Promise<{
  distanceMeters: number | null;
  durationSeconds: number | null;
  polyline: string | null;
}> {
  return computeRoutes(origin, destination);
}
