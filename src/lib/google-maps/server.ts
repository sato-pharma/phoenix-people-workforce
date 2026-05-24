type LatLng = { lat: number; lng: number };

const _reverseGeocodeCache = new Map<string, GeocodeResponse | null>();
const _geocodeAddressCache = new Map<string, LatLng | null>();
const _computeRoutesCache = new Map<string, {
  alternatives: GoogleRouteAlternative[];
  distanceMeters: number | null;
  durationInTrafficSeconds: number | null;
  durationSeconds: number | null;
  polyline: string | null;
  selectedRouteIndex: number | null;
}>();

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

type GoogleGeocodeAddressComponent = {
  longText?: string;
  long_name?: string;
  shortText?: string;
  short_name?: string;
  types?: string[];
};

type GoogleGeocodeResult = {
  addressComponents?: GoogleGeocodeAddressComponent[];
  formattedAddress?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  location?: { latitude?: number; longitude?: number };
  placeId?: string;
};

export type GoogleGeocodeCandidate = {
  area: string | null;
  city: string | null;
  country: string | null;
  formattedAddress: string | null;
  label: string;
  lat: number;
  lng: number;
  placeId: string | null;
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

function firstConfiguredEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

export function getPlacesServerKey() {
  return firstConfiguredEnv(
    "GOOGLE_PLACES_SERVER_KEY",
    "GOOGLE_PLACES_API_KEY",
    "GOOGLE_MAPS_PLACES_KEY",
    "GOOGLE_MAPS_SERVER_KEY",
  );
}

function getRoutesServerKey() {
  return firstConfiguredEnv(
    "GOOGLE_ROUTES_SERVER_KEY",
    "GOOGLE_ROUTES_API_KEY",
    "GOOGLE_MAPS_ROUTES_KEY",
    "GOOGLE_MAPS_SERVER_KEY",
  );
}

function getGeocodingServerKey() {
  return firstConfiguredEnv(
    "GOOGLE_GEOCODING_SERVER_KEY",
    "GOOGLE_GEOCODING_API_KEY",
    "GOOGLE_MAPS_GEOCODING_KEY",
    "GOOGLE_MAPS_SERVER_KEY",
  );
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
  const key = getRoutesServerKey();
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

  const routesCacheKey = `${origin.lat},${origin.lng},${destination.lat},${destination.lng}`;
  const cached = _computeRoutesCache.get(routesCacheKey);
  if (cached) return cached;

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

  const routesResult = {
    alternatives,
    distanceMeters: route ? routeDistanceMeters(route) : null,
    durationInTrafficSeconds: route ? routeDurationInTrafficSeconds(route) : null,
    durationSeconds: route ? routeDurationSeconds(route) : null,
    polyline: route?.polyline?.encodedPolyline ?? null,
    selectedRouteIndex: selectedRouteIndex >= 0 ? selectedRouteIndex : null,
  };
  _computeRoutesCache.set(routesCacheKey, routesResult);
  return routesResult;
}

export function getBrowserKey() {
  return process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? "";
}

export function hasGoogleServerKey() {
  return [
    getPlacesServerKey(),
    getRoutesServerKey(),
    getGeocodingServerKey(),
  ].some((key) => key.trim().length > 0);
}

export async function googleGeocodeAddress(address: string): Promise<LatLng | null> {
  const key = getGeocodingServerKey();
  if (!key || !address.trim()) return null;

  const normalizedAddress = address.trim();
  if (_geocodeAddressCache.has(normalizedAddress)) {
    return _geocodeAddressCache.get(normalizedAddress) ?? null;
  }

  const url = new URL(`https://geocode.googleapis.com/v4/geocode/address/${encodeURIComponent(normalizedAddress)}`);

  const response = await fetch(url.toString(), {
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "results.location",
    },
  });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Google Geocoding API failed with ${response.status}${details ? `: ${details.slice(0, 240)}` : ""}.`,
    );
  }

  const payload = (await response.json()) as {
    results?: GoogleGeocodeResult[];
  };

  const location = getGeocodeResultLocation(payload.results?.[0]);
  if (!location) {
    _geocodeAddressCache.set(normalizedAddress, null);
    return null;
  }

  _geocodeAddressCache.set(normalizedAddress, location);
  return location;
}

export async function googleGeocodeAddressCandidates(address: string): Promise<GoogleGeocodeCandidate[]> {
  const key = getGeocodingServerKey();
  if (!key || !address.trim()) return [];

  const normalizedAddress = address.trim();
  const url = new URL(`https://geocode.googleapis.com/v4/geocode/address/${encodeURIComponent(normalizedAddress)}`);

  const response = await fetch(url.toString(), {
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "results.addressComponents,results.formattedAddress,results.location,results.placeId",
    },
  });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Google Geocoding API failed with ${response.status}${details ? `: ${details.slice(0, 240)}` : ""}.`,
    );
  }

  const payload = (await response.json()) as {
    results?: GoogleGeocodeResult[];
  };

  return (payload.results ?? [])
    .map(geocodeResultToCandidate)
    .filter((candidate): candidate is GoogleGeocodeCandidate => candidate != null);
}

function extractAddressComponent(
  components: Array<GoogleGeocodeAddressComponent> | undefined,
  targetTypes: string[],
) {
  const component = components?.find((entry) =>
    Array.isArray(entry.types) && entry.types.some((type) => targetTypes.includes(type)),
  );
  return component?.longText ?? component?.shortText ?? component?.long_name ?? component?.short_name ?? null;
}

function getGeocodeResultLocation(result: GoogleGeocodeResult | null | undefined): LatLng | null {
  const lat = Number(result?.location?.latitude ?? result?.geometry?.location?.lat);
  const lng = Number(result?.location?.longitude ?? result?.geometry?.location?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function geocodeResultToCandidate(
  result: GoogleGeocodeResult | null | undefined,
): GoogleGeocodeCandidate | null {
  const geo = getGeocodeResultLocation(result);
  if (!result || !geo) return null;

  const governorate =
    extractAddressComponent(result.addressComponents, [
      "administrative_area_level_1",
    ]) ?? null;
  const city =
    extractAddressComponent(result.addressComponents, [
      "locality",
      "administrative_area_level_2",
      "sublocality",
      "sublocality_level_1",
    ]) ?? null;
  const area =
    governorate ??
    extractAddressComponent(result.addressComponents, [
      "administrative_area_level_2",
    ]) ??
    null;
  const country = extractAddressComponent(result.addressComponents, ["country"]) ?? null;
  const label = result.formattedAddress ?? [city, area, country].filter(Boolean).join(", ");

  if (!label) return null;

  return {
    area,
    city,
    country,
    formattedAddress: result.formattedAddress ?? null,
    label,
    lat: geo.lat,
    lng: geo.lng,
    placeId: result.placeId ?? null,
  };
}

export async function googleReverseGeocode(
  location: LatLng,
): Promise<GeocodeResponse | null> {
  const key = getGeocodingServerKey();
  if (!key) return null;

  const cacheKey = `${location.lat},${location.lng}`;
  if (_reverseGeocodeCache.has(cacheKey)) {
    return _reverseGeocodeCache.get(cacheKey) ?? null;
  }

  const url = new URL(`https://geocode.googleapis.com/v4/geocode/location/${encodeURIComponent(cacheKey)}`);

  const response = await fetch(url.toString(), {
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "results.addressComponents,results.formattedAddress,results.location",
    },
  });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Google Reverse Geocoding API failed with ${response.status}${details ? `: ${details.slice(0, 240)}` : ""}.`,
    );
  }

  const payload = (await response.json()) as {
    results?: GoogleGeocodeResult[];
  };

  const result = payload.results?.[0];
  const geo = getGeocodeResultLocation(result);
  if (!result || !geo) {
    _reverseGeocodeCache.set(cacheKey, null);
    return null;
  }

  const geocoded: GeocodeResponse = {
    area:
      extractAddressComponent(result.addressComponents, [
        "sublocality",
        "sublocality_level_1",
        "administrative_area_level_2",
      ]) ?? null,
    city:
      extractAddressComponent(result.addressComponents, [
        "locality",
        "administrative_area_level_1",
      ]) ?? null,
    formattedAddress: result.formattedAddress ?? null,
    lat: geo.lat,
    lng: geo.lng,
  };
  _reverseGeocodeCache.set(cacheKey, geocoded);
  return geocoded;
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
