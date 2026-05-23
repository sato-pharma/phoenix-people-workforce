import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractAddressComponent(
  components: Array<{ long_name?: string; short_name?: string; types?: string[] }> | undefined,
  targetTypes: string[],
) {
  const component = components?.find(
    (entry) =>
      Array.isArray(entry.types) && entry.types.some((type) => targetTypes.includes(type)),
  );
  return component?.long_name ?? component?.short_name ?? null;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "read");

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

    const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
    url.searchParams.set("place_id", placeId);
    url.searchParams.set(
      "fields",
      "geometry,name,formatted_address,address_components",
    );
    url.searchParams.set("key", key);
    url.searchParams.set("language", "ar");
    if (sessiontoken) url.searchParams.set("sessiontoken", sessiontoken);

    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Google Places Details failed with ${response.status}.`);
    }

    const payload = (await response.json()) as {
      result?: {
        address_components?: Array<{
          long_name?: string;
          short_name?: string;
          types?: string[];
        }>;
        formatted_address?: string;
        geometry?: {
          location?: { lat?: number; lng?: number };
        };
        name?: string;
      };
      status?: string;
    };

    const result = payload.result;
    if (!result?.geometry?.location) {
      return NextResponse.json(
        { error: "place_not_found", message: "Place details could not be resolved." },
        { status: 404 },
      );
    }

    const lat = Number(result.geometry.location.lat);
    const lng = Number(result.geometry.location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json(
        { error: "invalid_coordinates", message: "Place coordinates are invalid." },
        { status: 422 },
      );
    }

    const components = result.address_components;
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

    return NextResponse.json({
      area,
      city,
      country,
      formattedAddress: result.formatted_address ?? result.name ?? "",
      label: result.name ?? result.formatted_address ?? "",
      latitude: lat,
      longitude: lng,
      placeId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Place details lookup failed.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "place_details_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
