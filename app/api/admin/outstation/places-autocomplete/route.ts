import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "outstation", "read");

    const { searchParams } = new URL(request.url);
    const input = searchParams.get("input")?.trim() ?? "";
    const sessiontoken = searchParams.get("sessiontoken") ?? "";

    if (!input) {
      return NextResponse.json({ predictions: [] });
    }

    const key = process.env.GOOGLE_MAPS_SERVER_KEY ?? "";
    if (!key) {
      return NextResponse.json(
        { error: "maps_unavailable", message: "Google Maps is not configured on this server." },
        { status: 503 },
      );
    }

    const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
    url.searchParams.set("input", input);
    url.searchParams.set("key", key);
    url.searchParams.set("language", "ar");
    if (sessiontoken) url.searchParams.set("sessiontoken", sessiontoken);

    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Google Places Autocomplete failed with ${response.status}.`);
    }

    const payload = (await response.json()) as {
      predictions?: Array<{
        description?: string;
        place_id?: string;
      }>;
      status?: string;
    };

    const predictions = (payload.predictions ?? [])
      .filter((prediction) => prediction.place_id && prediction.description)
      .map((prediction) => ({
        description: prediction.description!,
        placeId: prediction.place_id!,
      }));

    return NextResponse.json({ predictions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Places autocomplete failed.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "places_autocomplete_failed", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
