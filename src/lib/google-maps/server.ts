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
  // administrative_area_level_1, " Governorate" suffix stripped (e.g. "Dakahlia").
  // Raw Google value (language follows the account default) — canonicalize with
  // resolveGovernorate() at the call site before comparing.
  governorate: string | null;
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

/**
 * Whether a server-side Maps key exists at all. Every Routes/Places helper here answers with
 * nulls when the key is missing, which is indistinguishable from a genuine "no result" — callers
 * that report the failure to a human must check this first so a configuration outage is never
 * described as a bad destination.
 */
export function isGoogleMapsServerKeyConfigured() {
  return getServerKey().trim().length > 0;
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

function extractAddressComponent(
  components: Array<{ long_name?: string; short_name?: string; types?: string[] }> | undefined,
  targetTypes: string[],
) {
  const component = components?.find((entry) =>
    Array.isArray(entry.types) && entry.types.some((type) => targetTypes.includes(type)),
  );
  return component?.long_name ?? component?.short_name ?? null;
}

export type GeocodeComponents = {
  lat: number;
  lng: number;
  // administrative_area_level_1, English, " Governorate" suffix stripped (e.g. "Dakahlia").
  governorate: string | null;
  // administrative_area_level_2 — the markaz / city level (e.g. "Mansoura").
  markaz: string | null;
};

// ── Places text search (what Google Maps the app actually uses) ──────────────
// The Geocoding API is built for street addresses and is poor at Egyptian district names: asked
// for "الحضرة الجديدة" it returned an electronics shop in Montaza, 8.5 km from the real district,
// flagged partial_match. Places text search finds the district — but ranks businesses NAMED after
// it above the place itself, so the first result is often a restaurant or hotel. Scanning for the
// first genuinely geographic result fixes both problems:
//   الحضرة الجديدة → result[2] "Al Hadrah" (locality)
//   العصافرة بحرى  → result[7] "Asafra"    (neighborhood)
// Measured against the old geocoded pins this moved سفاجا 314 km, الاقصر 180 km, الزرقا 64 km.

const GEOGRAPHIC_PLACE_TYPES = new Set([
  "administrative_area_level_2",
  "administrative_area_level_3",
  "locality",
  "neighborhood",
  "postal_town",
  "sublocality",
  "sublocality_level_1",
]);

export type PlaceMatch = {
  formattedAddress: string | null;
  /** True when the match is a real place (locality/neighborhood/…), false for a business. */
  isGeographic: boolean;
  lat: number;
  lng: number;
  name: string | null;
  types: string[];
};

/**
 * Text-search a place, preferring a genuinely geographic result over a business that merely
 * shares the name. Returns null when nothing is found. Uses Places API (New) — the legacy
 * Places endpoints are disabled on the Phoenix key.
 */
export async function googlePlacesTextSearch(searchText: string): Promise<PlaceMatch | null> {
  const key = getServerKey();
  if (!key || !searchText.trim()) return null;

  const response = await postJsonWithHttpsFallback("https://places.googleapis.com/v1/places:searchText", {
    body: JSON.stringify({ languageCode: "en", maxResultCount: 10, regionCode: "EG", textQuery: searchText }),
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location,places.types",
    },
    method: "POST",
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as {
    places?: Array<{
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
      types?: string[];
    }>;
  };
  const places = payload.places ?? [];
  if (places.length === 0) return null;

  const toMatch = (place: (typeof places)[number]): PlaceMatch | null => {
    const lat = place.location?.latitude;
    const lng = place.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const types = place.types ?? [];
    return {
      formattedAddress: place.formattedAddress ?? null,
      isGeographic: types.some((type) => GEOGRAPHIC_PLACE_TYPES.has(type)),
      lat: Number(lat),
      lng: Number(lng),
      name: place.displayName?.text ?? null,
      types,
    };
  };

  for (const place of places) {
    const match = toMatch(place);
    if (match?.isGeographic) return match;
  }
  // No real place in the list — the top business is still usually inside the district, but the
  // caller must treat it as lower confidence (isGeographic = false).
  for (const place of places) {
    const match = toMatch(place);
    if (match) return match;
  }
  return null;
}

// ── Places autocomplete (the "type and pick the nearest point" flow) ─────────
// googlePlacesTextSearch above answers "what is the ONE best match for this text" and is the right
// tool for batch geocoding. It is the wrong tool when a human is choosing: it silently picks for
// them, and its geographic-result preference would skip past the clinic or pharmacy they actually
// mean in favour of the district it sits in. Autocomplete returns the ranked list instead and lets
// the person pick, exactly like the Google Maps search box on a phone.

export type PlaceSuggestion = {
  /** Full one-line label, safe to render on its own. */
  description: string;
  placeId: string;
  /** The place's own name — "Dr Ahmed Clinic". */
  primaryText: string;
  /** Where it is — "Smouha, Alexandria". Null when Google returns no context line. */
  secondaryText: string | null;
};

/**
 * Ranked place suggestions for a partial query, Egypt-biased. Returns [] rather than throwing when
 * the key is missing or Google refuses, so a lookup failure degrades to "no suggestions" instead of
 * breaking the form the user is filling in.
 */
export async function googlePlacesAutocomplete(input: string): Promise<PlaceSuggestion[]> {
  const key = getServerKey();
  const query = input.trim();
  if (!key || !query) return [];

  const response = await postJsonWithHttpsFallback("https://places.googleapis.com/v1/places:autocomplete", {
    body: JSON.stringify({ input: query, languageCode: "en", regionCode: "EG" }),
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
    },
    method: "POST",
  });
  if (!response.ok) return [];

  const payload = (await response.json()) as {
    suggestions?: Array<{
      placePrediction?: {
        placeId?: string;
        structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
        text?: { text?: string };
      };
    }>;
  };

  return (payload.suggestions ?? []).flatMap((suggestion) => {
    const prediction = suggestion.placePrediction;
    const placeId = prediction?.placeId?.trim();
    if (!placeId) return [];

    const primaryText = prediction?.structuredFormat?.mainText?.text?.trim()
      ?? prediction?.text?.text?.trim()
      ?? "";
    if (!primaryText) return [];
    const secondaryText = prediction?.structuredFormat?.secondaryText?.text?.trim() || null;

    return [{
      description: prediction?.text?.text?.trim()
        || [primaryText, secondaryText].filter(Boolean).join(", "),
      placeId,
      primaryText,
      secondaryText,
    }];
  });
}

// ── Places nearby search (what is physically around a point) ─────────────────
// Text search answers "find the thing I named"; this answers "what of TYPE X sits within R
// metres of here". Pharmacy Search needs it for hospitals specifically: the database holds 285
// hospitals as customer rows and only 38 with coordinates, which is nowhere near all of them, so
// the rest can only come from Google.

export type NearbyPlace = {
  address: string | null;
  lat: number;
  lng: number;
  name: string;
};

/**
 * Places of `includedType` within `radiusMeters` of a point, nearest first, Egypt-biased.
 *
 * Returns [] rather than throwing when the key is missing or Google refuses — a failed
 * enrichment must degrade to "nothing found", never break a profile the caller already built
 * from our own data. `maxResultCount` is capped at 20 by the API.
 */
export async function googlePlacesNearbySearch(options: {
  includedType: string;
  latitude: number;
  longitude: number;
  maxResultCount?: number;
  radiusMeters: number;
}): Promise<NearbyPlace[]> {
  const key = getServerKey();
  if (!key) return [];

  const response = await postJsonWithHttpsFallback("https://places.googleapis.com/v1/places:searchNearby", {
    body: JSON.stringify({
      includedTypes: [options.includedType],
      languageCode: "en",
      locationRestriction: {
        circle: {
          center: { latitude: options.latitude, longitude: options.longitude },
          radius: Math.min(50_000, Math.max(1, options.radiusMeters)),
        },
      },
      maxResultCount: Math.min(20, Math.max(1, options.maxResultCount ?? 10)),
      rankPreference: "DISTANCE",
    }),
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
    },
    method: "POST",
  });
  if (!response.ok) return [];

  const payload = (await response.json()) as {
    places?: Array<{
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    }>;
  };

  return (payload.places ?? []).flatMap((place) => {
    const lat = place.location?.latitude;
    const lng = place.location?.longitude;
    const name = place.displayName?.text?.trim();
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    return [{
      address: place.formattedAddress?.trim() || null,
      lat: Number(lat),
      lng: Number(lng),
      name,
    }];
  });
}

export type PlaceLocation = {
  /** District / markaz level, the value the marketing forms store as the area name. */
  area: string | null;
  formattedAddress: string | null;
  /** administrative_area_level_1 with the " Governorate" suffix stripped, matching googleReverseGeocode. */
  governorate: string | null;
  lat: number;
  lng: number;
  name: string | null;
};

// Places API (New) returns address components as longText/shortText, NOT the geocoding API's
// long_name/short_name — extractAddressComponent above cannot read them.
function extractPlaceComponent(
  components: Array<{ longText?: string; shortText?: string; types?: string[] }> | undefined,
  targetTypes: string[],
) {
  const component = components?.find((entry) =>
    Array.isArray(entry.types) && entry.types.some((type) => targetTypes.includes(type)),
  );
  return component?.longText ?? component?.shortText ?? null;
}

/**
 * Resolve a place id from `googlePlacesAutocomplete` into coordinates plus the area/governorate the
 * marketing validation records store. Null when the id is unknown or the key is missing.
 */
export async function googlePlaceDetails(placeId: string): Promise<PlaceLocation | null> {
  const key = getServerKey();
  const id = placeId.trim();
  if (!key || !id) return null;

  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "addressComponents,displayName,formattedAddress,location",
    },
  });
  if (!response.ok) return null;

  const payload = (await response.json()) as {
    addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  };

  const lat = payload.location?.latitude;
  const lng = payload.location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const governorate = extractPlaceComponent(payload.addressComponents, ["administrative_area_level_1"]);
  return {
    area: extractPlaceComponent(payload.addressComponents, [
      "sublocality",
      "sublocality_level_1",
      "neighborhood",
      "locality",
      "administrative_area_level_2",
    ]),
    formattedAddress: payload.formattedAddress ?? null,
    governorate: governorate ? governorate.replace(/\s*Governorate$/i, "").trim() : null,
    lat: Number(lat),
    lng: Number(lng),
    name: payload.displayName?.text ?? null,
  };
}

// One Geocoding call returning coordinates + admin level 1/2 together (the older helpers each
// discard part of the payload, forcing double billing when both are needed).
export async function googleGeocodeComponents(searchText: string): Promise<GeocodeComponents | null> {
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
      address_components?: Array<{ long_name?: string; short_name?: string; types?: string[] }>;
      geometry?: { location?: { lat?: number; lng?: number } };
    }>;
  };

  const result = payload.results?.[0];
  const location = result?.geometry?.location;
  if (!result || !location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return null;
  }

  const governorate = extractAddressComponent(result.address_components, ["administrative_area_level_1"]);
  const markaz = extractAddressComponent(result.address_components, ["administrative_area_level_2"]);
  return {
    governorate: governorate ? governorate.replace(/\s*Governorate$/i, "").trim() : null,
    lat: Number(location.lat),
    lng: Number(location.lng),
    markaz: markaz ? markaz.trim() : null,
  };
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

  const governorate = extractAddressComponent(result.address_components, [
    "administrative_area_level_1",
  ]);
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
    governorate: governorate ? governorate.replace(/\s*Governorate$/i, "").trim() : null,
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
