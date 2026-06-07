import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";

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
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "id,displayName,formattedAddress,location,addressComponents",
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

    return NextResponse.json({
      area,
      city,
      country,
      formattedAddress: result.formattedAddress ?? displayName ?? "",
      label: displayName || result.formattedAddress || "",
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
