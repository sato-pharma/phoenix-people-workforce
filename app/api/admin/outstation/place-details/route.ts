import { NextResponse } from "next/server";

import { assertAdminManagerExpenseAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

type AddressComponent = {
  longText?: string;
  long_name?: string;
  shortText?: string;
  short_name?: string;
  types?: string[];
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractAddressComponent(
  components: Array<AddressComponent> | undefined,
  targetTypes: string[],
) {
  const component = components?.find(
    (entry) =>
      Array.isArray(entry.types) && entry.types.some((type) => targetTypes.includes(type)),
  );
  return component?.longText ?? component?.shortText ?? component?.long_name ?? component?.short_name ?? null;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAdminManagerExpenseAccess(access);

    const { searchParams } = new URL(request.url);
    const placeId = searchParams.get("placeId")?.trim() ?? "";
    const normalizedPlaceId = placeId.startsWith("places/") ? placeId.slice("places/".length) : placeId;
    const sessiontoken = searchParams.get("sessiontoken") ?? "";

    if (!normalizedPlaceId) {
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

    const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(normalizedPlaceId)}`);
    if (sessiontoken) {
      url.searchParams.set("sessionToken", sessiontoken);
    }

    const response = await fetch(url.toString(), {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "id,displayName,formattedAddress,addressComponents,location",
      },
      method: "GET",
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(
        `Google Places Details failed with ${response.status}${details ? `: ${details.slice(0, 240)}` : ""}.`,
      );
    }

    const payload = (await response.json()) as {
      addressComponents?: Array<AddressComponent>;
      error?: {
        message?: string;
      };
      formattedAddress?: string;
      location?: {
        latitude?: number;
        longitude?: number;
      };
      displayName?: {
        text?: string;
      };
    };

    if (payload.error) {
      return NextResponse.json(
        {
          error: "place_details_failed",
          message: payload.error.message ?? "Google Places details request failed.",
        },
        { status: 502 },
      );
    }

    const lat = Number(payload.location?.latitude);
    const lng = Number(payload.location?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json(
        { error: "place_not_found", message: "Place details could not be resolved." },
        { status: 404 },
      );
    }

    const components = payload.addressComponents;
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
    const country = extractAddressComponent(components, ["country"]) ?? null;

    return NextResponse.json({
      area,
      city,
      country,
      formattedAddress: payload.formattedAddress ?? payload.displayName?.text ?? "",
      label: payload.displayName?.text ?? payload.formattedAddress ?? "",
      latitude: lat,
      longitude: lng,
      placeId: normalizedPlaceId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Place details lookup failed.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "place_details_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
