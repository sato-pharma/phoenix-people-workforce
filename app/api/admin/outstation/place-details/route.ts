import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractAddressComponent(
  components: Array<{ longText?: string; shortText?: string; types?: string[] }> | undefined,
  targetTypes: string[],
) {
  const component = components?.find(
    (entry) =>
      Array.isArray(entry.types) && entry.types.some((type) => targetTypes.includes(type)),
  );
  return component?.longText ?? component?.shortText ?? null;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "approve");

    const { searchParams } = new URL(request.url);
    const placeId = searchParams.get("placeId")?.trim() ?? "";
    const sessiontoken = searchParams.get("sessiontoken") ?? "";

    if (!placeId) {
      return NextResponse.json(
        { error: "missing_place_id", message: "placeId is required." },
        { status: 400 },
      );
    }

    const key = process.env.GOOGLE_MAPS_SERVER_KEY ?? "";
    if (!key) {
      return NextResponse.json(
        { error: "maps_unavailable", message: "Google Maps is not configured on this server." },
        { status: 503 },
      );
    }

    // Places API (New). The legacy Places API is no longer enabled for this
    // project, so we call the v1 place details endpoint.
    const url = new URL(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    );
    url.searchParams.set("languageCode", "ar");
    if (sessiontoken) url.searchParams.set("sessionToken", sessiontoken);

    const response = await fetch(url.toString(), {
      cache: "no-store",
      // Eight seconds, then the catch below answers (integration audit, 13 Nov 2026, ISS-011); it had no deadline.
      signal: AbortSignal.timeout(8_000),
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "id,displayName,formattedAddress,location,addressComponents,types",
      },
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(
        `Google Places Details failed with ${response.status}${details ? `: ${details.slice(0, 240)}` : ""}.`,
      );
    }

    const result = (await response.json()) as {
      addressComponents?: Array<{
        longText?: string;
        shortText?: string;
        types?: string[];
      }>;
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
      types?: string[];
    };

    if (!result.location) {
      return NextResponse.json(
        { error: "place_not_found", message: "Place details could not be resolved." },
        { status: 404 },
      );
    }

    const lat = Number(result.location.latitude);
    const lng = Number(result.location.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json(
        { error: "invalid_coordinates", message: "Place coordinates are invalid." },
        { status: 422 },
      );
    }

    const components = result.addressComponents;
    const city =
      extractAddressComponent(components, [
        "administrative_area_level_1",
        "locality",
      ]) ?? null;
    const area =
      extractAddressComponent(components, [
        "administrative_area_level_2",
        "sublocality",
        "sublocality_level_1",
      ]) ?? null;
    const country =
      extractAddressComponent(components, ["country"]) ?? null;

    const displayName = result.displayName?.text ?? "";

    // Detect regions whose representative point can sit far from the place the admin means —
    // a governorate or coarser. NOT a markaz/qism: administrative_area_level_2..4 in Egypt are
    // town-level, and their centre IS the town. Measured 2026-08-23 from a Cairo residence:
    // Ibsheway markaz centre 109.3 km vs the locality Ibshaway 109.0 km — 0.3 km apart, so
    // warning on it was pure noise. A governorate centre is a different animal: Faiyum
    // Governorate centre is 116.0 km vs Faiyum city 100.2 km, and the centres of New Valley,
    // Marsa Matrouh, Red Sea and South Sinai are roadless desert that Google cannot route to
    // at all.
    const types = Array.isArray(result.types) ? result.types : [];
    const SPECIFIC_PLACE_TYPES = new Set([
      "locality",
      "sublocality",
      "sublocality_level_1",
      "neighborhood",
      "premise",
      "subpremise",
      "street_address",
      "route",
      "intersection",
      "establishment",
      "point_of_interest",
      "airport",
      "transit_station",
    ]);
    const BROAD_REGION_TYPES = new Set([
      "administrative_area_level_1",
      "country",
      "colloquial_area",
      "archipelago",
      "continent",
    ]);
    const isAdministrativeArea =
      !types.some((type) => SPECIFIC_PLACE_TYPES.has(type)) &&
      types.some((type) => BROAD_REGION_TYPES.has(type));

    return NextResponse.json({
      area,
      city,
      country,
      formattedAddress: result.formattedAddress ?? displayName ?? "",
      isAdministrativeArea,
      label: displayName || result.formattedAddress || "",
      latitude: lat,
      longitude: lng,
      placeId,
      types,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Place details lookup failed.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "place_details_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
